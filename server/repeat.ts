// Probable repeats: a new task whose label nearly matches a task already done
// in the same repo. The same symptom was fixed several times ("ready for review
// stays after merge", KPI text rendering, epic import creating tasks); tagging
// the new task makes that visible on the task and in the improvement evidence.
// Deterministic token overlap, no LLM: it only has to catch near-identical labels.

import { taskLabel, type Task } from "./types.ts";
import { labelKey, labelTokens } from "../shared/label-tokens.ts";

export { labelTokens };

/** A label needs this many meaningful tokens before it can match: short
 *  labels ("fix tests") share too much by chance. */
export const MIN_TOKENS = 3;

/** Share of shared tokens (Jaccard) from which two labels count as the same work. */
export const REPEAT_THRESHOLD = 0.6;

/** Jaccard overlap of two labels' tokens; 0 when either is too short to judge. */
export function labelSimilarity(a: string, b: string): number {
  const ta = labelTokens(a);
  const tb = labelTokens(b);
  if (ta.size < MIN_TOKENS || tb.size < MIN_TOKENS) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

type Candidate = Pick<Task, "id" | "title" | "prompt" | "status" | "repo_path"> & Pick<Partial<Task>, "kind" | "exit_code" | "updated_ms">;

/** A run that ended badly: the session exited with a non-zero code. */
function failed(c: Candidate): boolean {
  return c.status === "done" && c.exit_code !== null && c.exit_code !== undefined && c.exit_code !== 0;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** Kinds that never change code: a second review of the same PR is not a repeat. */
function comparable(kind: Task["kind"]): boolean {
  return kind !== "review" && kind !== "spec" && kind !== "analysis";
}

/**
 * The done task in the same repo the new task most likely repeats, or null.
 * A done task is compared by its title and by its prompt's first line: the
 * title usually comes from the agent session after dispatch, while the new
 * task often has only its prompt.
 */
export function findRepeatOf(task: Candidate, candidates: Candidate[]): string | null {
  if (!comparable(task.kind) || !task.repo_path) return null;
  const label = taskLabel(task);
  let best: { id: string; score: number } | null = null;
  for (const c of candidates) {
    if (c.id === task.id || c.status !== "done" || failed(c) || c.repo_path !== task.repo_path || !comparable(c.kind)) continue;
    const score = Math.max(labelSimilarity(label, c.title), labelSimilarity(label, firstLine(c.prompt)));
    if (score >= REPEAT_THRESHOLD && (!best || score > best.score)) best = { id: c.id, score };
  }
  return best?.id ?? null;
}

/** How far back a retry looks: a task given up and recreated the same day. */
export const RETRY_WINDOW_MS = 24 * 3_600_000;

/**
 * The task the new one retries, or null: same normalized label as a task
 * archived or failed in the last 24 hours, in any repo and on any harness.
 * Both seen cases switched one of them (wrong repo, then another harness), so
 * neither is part of the match. Not the automatic stopped-agent retry of
 * ADR 0016: this is the human recreating the task.
 */
export function findRetryOf(task: Candidate, candidates: Candidate[], now: number): string | null {
  if (!comparable(task.kind)) return null;
  const key = labelKey(taskLabel(task));
  if (!key) return null;
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (c.id === task.id || !comparable(c.kind) || (c.status !== "archived" && !failed(c))) continue;
    if ((c.updated_ms ?? 0) < now - RETRY_WINDOW_MS) continue;
    if (labelKey(c.title) !== key && labelKey(firstLine(c.prompt)) !== key) continue;
    if (!best || (c.updated_ms ?? 0) > (best.updated_ms ?? 0)) best = c;
  }
  return best?.id ?? null;
}
