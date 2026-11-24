// Probable repeats: a new task whose label nearly matches a task already done
// in the same repo. The same symptom was fixed several times ("ready for review
// stays after merge", KPI text rendering, epic import creating tasks); tagging
// the new task makes that visible on the task and in the improvement evidence.
// Deterministic token overlap, no LLM: it only has to catch near-identical labels.

import { taskLabel, type Task } from "./types.ts";

// English and French: prompts are written in both. Conventional-commit types
// are noise too: a done title "fix(kpi): ..." must match a prompt without it.
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "from", "by", "with", "without",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "as", "into", "when",
  "not", "no", "do", "does", "should", "must", "can", "still", "after", "before", "so", "we", "i", "you", "our", "my",
  "le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "et", "ou", "en", "dans", "sur", "pour", "par", "avec",
  "sans", "au", "aux", "ce", "cet", "cette", "ces", "est", "sont", "pas", "ne", "plus", "qui", "que", "qu", "il", "elle",
  "ils", "on", "se", "s", "y", "je", "nous", "vous", "mon", "ma", "mes", "son", "sa", "ses", "quand", "apres", "avant",
  "fix", "feat", "chore", "refactor", "docs", "style", "perf",
]);

/** A label needs this many meaningful tokens before it can match: short
 *  labels ("fix tests") share too much by chance. */
export const MIN_TOKENS = 3;

/** Share of shared tokens (Jaccard) from which two labels count as the same work. */
export const REPEAT_THRESHOLD = 0.6;

/** Normalized tokens of a label: lowercase, accents and punctuation stripped,
 *  Jira keys and stop words dropped, a trailing plural "s" removed. */
export function labelTokens(text: string): Set<string> {
  const tokens = text
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
  return new Set(tokens);
}

/** Jaccard overlap of two labels' tokens; 0 when either is too short to judge. */
export function labelSimilarity(a: string, b: string): number {
  const ta = labelTokens(a);
  const tb = labelTokens(b);
  if (ta.size < MIN_TOKENS || tb.size < MIN_TOKENS) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

type Candidate = Pick<Task, "id" | "title" | "prompt" | "status" | "repo_path"> & Pick<Partial<Task>, "kind">;

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
    if (c.id === task.id || c.status !== "done" || c.repo_path !== task.repo_path || !comparable(c.kind)) continue;
    const firstLine = c.prompt.trim().split("\n")[0] ?? "";
    const score = Math.max(labelSimilarity(label, c.title), labelSimilarity(label, firstLine));
    if (score >= REPEAT_THRESHOLD && (!best || score > best.score)) best = { id: c.id, score };
  }
  return best?.id ?? null;
}
