// Shared types for Corral. Keep this file erasable-syntax-only (no enums, no
// parameter properties): Node runs TypeScript via type stripping.

import type { TaskEvent } from "./task-events.ts";

export type AgentTarget = "claude" | "codex" | "opencode" | string;

export type TaskStatus = "open" | "dispatched" | "done" | "archived";
export type TargetState = "suggested" | "confirmed";
/** code: the agent changes code and opens a PR. review: the agent reviews an
 *  existing PR/MR (pr_url) and posts comments only after the human approves.
 *  spec: multi-repo step one — the agent works in a folder of sub-projects (not
 *  a git repo), writes the contract between them and proposes one code task per
 *  sub-project; no branch, no PR. ops: the agent carries out a request with a
 *  folder as context (the folder need not be a git repo) and reports back; no
 *  branch, no PR. grill: discussion interview in place. grill-docs: interview
 *  that writes docs, in a worktree with a PR when the folder is a git repo,
 *  in place with a digest otherwise. Both accept any folder. */
export type TaskKind = "code" | "review" | "spec" | "analysis" | "ops" | "grill" | "grill-docs";

/** One sub-task a spec proposes. `repo` is a directory relative to the spec task's folder. */
export interface PlanSubtask {
  repo: string;
  title: string;
  prompt: string;
}

/** What a spec task stores (JSON in `tasks.spec`): the contract between the
 *  sub-projects and the sub-tasks waiting for the human's approval. */
export interface TaskSpec {
  contract: string;
  subtasks: PlanSubtask[];
  /** Current immutable revision id in `plan_revisions` (absent on legacy rows). */
  revision_id?: string;
  /** Monotonic revision number for this spec task (1, 2, ...). */
  version?: number;
  /** Set once approved: the ids of the code tasks created from `subtasks`. */
  children?: string[];
}

/** One immutable plan snapshot submitted for a multi-repo `spec` task. */
export interface PlanRevision {
  id: string;
  task_id: string;
  version: number;
  title: string;
  contract: string;
  subtasks: PlanSubtask[];
  markdown: string;
  created_ms: number;
}

/** One inline reviewer comment anchored to a quoted passage in a plan revision. */
export interface PlanReviewComment {
  section: string;
  repo?: string | null;
  quote: string;
  body: string;
}

/** One submitted batch of revision feedback sent back to a spec agent. */
export interface PlanReview {
  id: string;
  task_id: string;
  revision_id: string;
  note: string;
  comments: PlanReviewComment[];
  created_ms: number;
}

/** Matches a GitHub pull request or GitLab merge request URL. */
export const PR_URL_RE = /^https?:\/\/[^\s/]+\/[^\s]+?(?:\/pull\/|\/-\/merge_requests\/)\d+\/?$/;

/** A file attached to a task's prompt. The bytes stay in the database: this is
 *  the metadata the API returns. */
export interface TaskAttachment {
  id: string;
  task_id: string;
  filename: string;
  content_type: string;
  bytes: number;
  created_ms: number;
}

/** A Jira epic mirrored in Corral. `description` is the epic's text (design v1). */
export interface Epic {
  id: string;
  jira_key: string;
  title: string;
  description: string;
  /** Set when the last sync found a problem (a dependency cycle); null when fine. */
  error: string | null;
  /** Hash of the design block as Corral last wrote it into the epic description. */
  design_block_hash?: string | null;
  /** Favorite and working directory picked on the Epic page, reused on later requests. */
  favorite_name?: string | null;
  repo_path?: string | null;
  synced_ms: number;
  created_ms: number;
}

/** One version of an epic's design. v1 is the epic's Jira text at import. */
export interface EpicDesign {
  epic_id: string;
  version: number;
  body: string;
  reason: string;
  author: string;
  created_ms: number;
}

/** A proposed change to one task after a design revision, waiting for the human. */
export interface EpicAmendment {
  id: string;
  epic_id: string;
  task_id: string;
  design_version: number;
  body: string;
  status: "proposed" | "applied" | "rejected";
  item_id: string | null;
  created_ms: number;
}

/** "task_key is blocked by blocked_by_key", both Jira keys of the same epic. */
export interface EpicLink {
  epic_id: string;
  task_key: string;
  blocked_by_key: string;
}

/** A Jira child ticket of an epic, synced as reference data without creating a Corral task. */
export interface EpicTicket {
  epic_id: string;
  jira_key: string;
  title: string;
  description: string;
  jira_url: string;
  jira_status: string | null;
  jira_parent_key: string | null;
  suggested_repo_path: string;
  updated_ms: number;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  /** Absent on rows written before the column existed: treat as "code". */
  kind?: TaskKind;
  repo_path: string;
  target: AgentTarget;
  target_state: TargetState;
  agent?: string | null;
  model?: string | null;
  reasoning?: string | null;
  /** Resolved review command line, frozen at dispatch (a named reviewer's command). */
  review?: string | null;
  base_branch: string | null;
  branch: string | null;
  worktree_path: string | null;
  assignee: string | null;
  jira_key: string | null;
  jira_url: string | null;
  jira_parent_key: string | null;
  /** Jira status name last reached by the status sync (cached: it is both the
   *  dedupe for later stages and what `GET /api/tasks` reports). */
  jira_status?: string | null;
  pr_url: string | null;
  /** JSON state for the PR loop, e.g. {"pushed":"<thread ids>"} (dedupe). */
  pr_meta: string | null;
  /** Handoff document from the last completed run — injected into follow-up sessions. */
  handoff?: string | null;
  /** The spec task that created this one (multi-repo): its contract is injected at dispatch. */
  parent_task_id?: string | null;
  /** Spec tasks only: JSON {@link TaskSpec}. */
  spec?: string | null;
  /** The Epic this task belongs to (its ticket is a child of the epic in Jira). */
  epic_id?: string | null;
  /** 1 once the ticket left the epic in Jira: kept, but no longer in its graph. */
  epic_out?: number;
  /** Design version of its epic when the task was dispatched. */
  design_version?: number | null;
  /** The amendment written into the Jira ticket (current one only) and the hash of that block. */
  amendment?: string | null;
  amendment_hash?: string | null;
  /** A done task in the same repo with a near-identical label: this task
   *  probably repeats it (see server/repeat.ts). Set once, at creation. */
  repeat_of?: string | null;
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

/** One task event with the task and repo fields the daily standup needs. */
export type DailyActivity = TaskEvent & {
  title: string;
  prompt: string;
  repo_name: string;
  repo_path: string;
  jira_url: string | null;
  jira_key: string | null;
  pr_url: string | null;
  terminal_address: string | null;
};

export type ItemKind = "question" | "pr" | "digest" | "plan" | "launch" | "amendment";
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
  /** For pr items: 1 while the agent has the PR work in flight (merge
   *  conflicts, review comments). The item waits under "In progress" instead
   *  of asking the human for something it cannot act on yet. Absent on rows
   *  written before the column existed: treat as 0. */
  handling?: number;
  /** Captured from a backend elicitation: JSON {id, kind}. Replies answer it
   *  through resolveElicitation instead of a new conversation message. */
  elicitation?: string | null;
  /** Observe-only PR risk triage JSON ({tier, depth, mode, reasons, source}). */
  triage?: string | null;
  created_ms: number;
  updated_ms: number;
  resolved_ms: number | null;
  snooze_until_ms: number | null;
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
  /** null reads as professional. */
  context: "professional" | "personal" | null;
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
