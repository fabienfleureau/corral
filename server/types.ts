// Shared types for Corral. Keep this file erasable-syntax-only (no enums, no
// parameter properties): Node runs TypeScript via type stripping.

export type AgentTarget = "claude" | "codex" | "opencode" | string;

export type TaskStatus = "open" | "dispatched" | "done" | "archived";
export type TargetState = "suggested" | "confirmed";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  repo_path: string;
  target: AgentTarget;
  target_state: TargetState;
  model?: string | null;
  reasoning?: string | null;
  base_branch: string | null;
  branch: string | null;
  worktree_path: string | null;
  assignee: string | null;
  jira_key: string | null;
  jira_url: string | null;
  jira_parent_key: string | null;
  pr_url: string | null;
  /** JSON state for the PR loop, e.g. {"pushed":"<thread ids>"} (dedupe). */
  pr_meta: string | null;
  /** Handoff document from the last completed run — injected into follow-up sessions. */
  handoff?: string | null;
  status: TaskStatus;
  terminal_address: string | null;
  exit_code: number | null;
  created_ms: number;
  updated_ms: number;
}

/** Display label: the task title, or the prompt's first line while the
 *  title is pending (omnigent names the session after dispatch). */
export function taskLabel(task: Pick<Task, "title" | "prompt">): string {
  return task.title.trim() || task.prompt.trim().split("\n")[0].slice(0, 80) || "Untitled task";
}

export type ItemKind = "question" | "pr" | "digest";
export type ItemStatus = "open" | "resolved" | "archived";

export interface Item {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  title: string;
  summary: string;
  body: string;
  /** Raw recent terminal output captured at report time (context drawer). */
  context: string;
  /** JSON array of quick-reply options the agent offered, e.g. ["all","none"]. */
  options: string | null;
  source_ref: string | null;
  task_id: string | null;
  structured: number;
  /** For pr items: 1 = the review gate passes (threads resolved, checks green). */
  ready: number;
  /** Captured from a backend elicitation: JSON {id, kind}. Replies answer it
   *  through resolveElicitation instead of a new conversation message. */
  elicitation?: string | null;
  created_ms: number;
  updated_ms: number;
  resolved_ms: number | null;
  snooze_until_ms: number | null;
}

export type IdeaTag = "workflow" | "product";
export type IdeaStatus = "new" | "promoted" | "dismissed";

export interface Idea {
  id: string;
  text: string;
  tag: IdeaTag;
  origin: "user" | "agent";
  status: IdeaStatus;
  created_ms: number;
}

export interface TrackedTerminal {
  address: string;
  task_id: string | null;
  name: string | null;
  agent: string | null;
  last_status: string | null;
  last_turn: number;
  updated_ms: number;
}

export interface Repo {
  id: string;
  name: string;
  path: string;
  jira_prefix: string | null;
  source: "manual" | "scan";
  created_ms: number;
}

/** Facts about a terminal, as herdr reports them (subset we care about). */
export interface HcTerminal {
  address: string;
  name: string | null;
  title: string;
  cwd: string;
  state: string;
  status: { app?: string; state?: string; title?: string } | null;
  status_ms: number | null;
  turn: number;
  parent: string | null;
  labels: Record<string, string>;
  exit_code: number | null;
  reason: string | null;
  agent?: string;
  records?: Record<string, { app?: string; state?: string; title?: string }>;
}

export type HcEventType =
  | "created"
  | "lost"
  | "restarted"
  | "keep"
  | "finished"
  | "removed"
  | "status"
  | "turn"
  | "title"
  | "labels"
  | "size"
  | "foreground";

export interface HcEvent {
  type: HcEventType;
  terminal: string;
  seq: number;
  data: Record<string, unknown>;
}

export interface MetricEvent {
  id: number;
  ts: number;
  name: string;
  ref: string | null;
  data: string | null;
}

export interface SessionInfo {
  address: string;
  name: string | null;
  agent: string | null;
  task_id: string | null;
  task_title: string | null;
  /** OSC 7501 state: working | blocked | idle | done | error (null when none reported). */
  status: string | null;
  /** live | finished */
  state: string;
  turn: number;
  cwd: string;
  created_ms: number;
  updated_ms: number;
  exit_code: number | null;
}
