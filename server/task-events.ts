// Task history: an append-only log of what happened to a task — creation,
// field edits, state changes, prompts sent, Jira moves, PR milestones, agent
// questions. It answers "how did this task get here?" from the inbox, so it
// records facts (a one-line message plus structured data), never UI state.
//
// Recording is best effort by design: a broken log must not fail the dispatch,
// reply or PR sync it documents.

import type { Task } from "./types.ts";

export type TaskEventKind =
  | "created"
  | "updated"
  | "status"
  | "prompt"
  | "question"
  | "jira"
  | "pr"
  | "session";

export interface TaskEvent {
  id: number;
  task_id: string;
  ts: number;
  kind: TaskEventKind;
  /** One-line human sentence, produced when the event was recorded. */
  message: string;
  /** JSON object holding the detail behind the message, or null. */
  data: string | null;
}

/** The only storage the log needs; `Db` implements it. */
export interface TaskEventStore {
  insertTaskEvent(event: Omit<TaskEvent, "id">): void;
}

/** Longest prompt text an event keeps. A dispatch prompt carries every
 *  convention file: the timeline only needs enough to recognise it. */
export const PROMPT_PREVIEW_CHARS = 2000;

const MESSAGE_MAX = 300;

/** Collapse whitespace and clip, so one event stays one readable line. */
export function oneLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Record one event. */
export function logTaskEvent(
  store: TaskEventStore,
  taskId: string,
  kind: TaskEventKind,
  message: string,
  data?: Record<string, unknown> | null,
): void {
  try {
    const entries = data
      ? Object.entries(data).filter(([, value]) => value !== undefined && value !== null && value !== "")
      : [];
    store.insertTaskEvent({
      task_id: taskId,
      ts: Date.now(),
      kind,
      message: oneLine(message, MESSAGE_MAX),
      data: entries.length ? JSON.stringify(Object.fromEntries(entries)) : null,
    });
  } catch {
    /* history is not worth breaking the write it describes */
  }
}

/** What to keep about a prompt sent to the agent: its full text when short
 *  enough to read, its size always. */
export function promptData(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    chars: text.length,
    text: text.length <= PROMPT_PREVIEW_CHARS ? text : `${text.slice(0, PROMPT_PREVIEW_CHARS)}\n…(${text.length} chars)`,
  };
}

interface Change {
  kind: TaskEventKind;
  message: string;
  data?: Record<string, unknown>;
}

/** The changes worth a line in a task's history. Field names that only drive
 *  bookkeeping (pr_meta, updated_ms, handoff) are deliberately absent. */
export function taskChanges(before: Task, patch: Partial<Task>): Change[] {
  const out: Change[] = [];

  if ("status" in patch && patch.status !== before.status) {
    out.push({
      kind: "status",
      message: `Status: ${before.status} → ${patch.status}`,
      data: { from: before.status, to: patch.status ?? null },
    });
  }
  if ("title" in patch && (patch.title ?? "") !== (before.title ?? "")) {
    const next = patch.title ?? "";
    out.push({
      kind: "updated",
      message: next.trim() ? `Title: ${oneLine(next, 100)}` : "Title cleared",
      data: { from: before.title ?? null, to: next || null },
    });
  }
  if ("prompt" in patch && (patch.prompt ?? "") !== (before.prompt ?? "")) {
    out.push({
      kind: "updated",
      message: "Description edited",
      data: { chars: (patch.prompt ?? "").length, previous_chars: (before.prompt ?? "").length },
    });
  }
  for (const field of ["repo_path", "target", "model", "reasoning", "agent", "assignee", "base_branch"] as const) {
    if (!(field in patch) || (patch[field] ?? null) === (before[field] ?? null)) continue;
    const next = patch[field] ? String(patch[field]) : null;
    const label = { repo_path: "Repository", target: "Harness", model: "Model", reasoning: "Reasoning", agent: "Agent", assignee: "Assignee", base_branch: "Base branch" }[field];
    out.push({
      kind: "updated",
      message: next ? `${label}: ${oneLine(next, 80)}` : `${label} cleared`,
      data: { field, from: before[field] ? String(before[field]) : null, to: next },
    });
  }
  if ("branch" in patch && (patch.branch ?? null) !== (before.branch ?? null)) {
    out.push({
      kind: "updated",
      message: patch.branch ? `Branch: ${patch.branch}` : "Branch cleared",
      data: { from: before.branch ?? null, to: patch.branch ?? null },
    });
  }
  if ("worktree_path" in patch && (patch.worktree_path ?? null) !== (before.worktree_path ?? null)) {
    out.push({
      kind: "session",
      message: patch.worktree_path ? `Worktree: ${patch.worktree_path}` : "Worktree removed",
      data: { from: before.worktree_path ?? null, to: patch.worktree_path ?? null },
    });
  }
  if ("pr_url" in patch && (patch.pr_url ?? null) !== (before.pr_url ?? null)) {
    out.push({
      kind: "pr",
      message: patch.pr_url ? `PR linked: ${patch.pr_url}` : "PR unlinked",
      data: { from: before.pr_url ?? null, to: patch.pr_url ?? null },
    });
  }
  if ("jira_status" in patch && (patch.jira_status ?? null) !== (before.jira_status ?? null)) {
    const next = patch.jira_status ?? null;
    out.push({
      kind: "jira",
      message: next
        ? before.jira_status ? `Jira: ${before.jira_status} → ${next}` : `Jira status: ${next}`
        : "Jira status cleared",
      data: { from: before.jira_status ?? null, to: next },
    });
  }
  if ("exit_code" in patch && (patch.exit_code ?? null) !== (before.exit_code ?? null)) {
    out.push({
      kind: "session",
      message: patch.exit_code === null || patch.exit_code === undefined
        ? "Exit code cleared"
        : `Session exited with code ${patch.exit_code}`,
      data: { exit_code: patch.exit_code ?? null },
    });
  }
  return out;
}

/** Record every history-worthy change of one task update. */
export function logTaskChanges(store: TaskEventStore, before: Task, patch: Partial<Task>): void {
  for (const change of taskChanges(before, patch)) logTaskEvent(store, before.id, change.kind, change.message, change.data);
}
