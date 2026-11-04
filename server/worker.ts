// Worker seam: one interface for "run an agent and talk to it", so the
// execution base (today omnigent, previously herdr-core) is an adapter, not a
// foundation. Everything above this line is Corral's domain: the inbox, Jira,
// the PR loop, confs/rules.

export interface WorkerStart {
  taskId: string | null;
  /** Display name of the task group, when available. */
  project?: string | null;
  /** Human label for the session (task slug etc.) — null = let the backend
   *  generate a title (untitled tasks). */
  name: string | null;
  /** Source repo directory (or a direct working directory when no git request). */
  repoPath: string;
  /** Worktree request: the backend prepares the worktree (omnigent does it
   *  as part of session creation). null = run in repoPath directly.
   *  existingWorktree: repoPath IS the worktree already (bind mode). */
  git: { branch: string; base: string | null; existingWorktree?: boolean } | null;
  prompt: string;
  /** Harness id: "claude" | "codex" | "opencode" | … (bare harness by default). */
  harness: string;
  /** Explicit agent choice (omnigent registry name/id) — null = bare harness. */
  agent?: string | null;
  /** Model pin — null = "let the backend route it" (omnigent smart routing). */
  model: string | null;
  /** Raw per-harness reasoning value — null = backend decides. */
  reasoning: string | null;
  env?: Record<string, string>;
}

export interface WorkerSession {
  address: string;
  /** Session-reported settings, when available. */
  model?: string | null;
  reasoning?: string | null;
  task_id: string | null;
  name: string | null;
  harness: string | null;
  /** working | blocked | idle | done | error | null */
  status: string | null;
  /** permission | question | auth | null — why it is blocked. */
  blocked_kind: string | null;
  /** live | finished */
  state: string;
  turn: number;
  /** Actual working directory (the worktree, when one was requested). */
  cwd: string;
  created_ms: number;
  exit_code: number | null;
  /** Parent session address in a sub-agent tree (null = top). */
  parent: string | null;
}

export interface WorkerQuestion {
  id: string;
  prompt: string;
  choices: string[];
  multiple: boolean;
}

export interface WorkerElicitation {
  id: string;
  /** permission | question | auth | unknown */
  kind: string;
  /** The prompt / question text shown to the human. */
  prompt: string;
  /** Choice labels when the elicitation offers options. */
  choices: string[];
  /** First requestedSchema property: where a typed answer goes on accept. */
  field?: string | null;
  questions?: WorkerQuestion[];
  persistPattern?: string;
}

export type WorkerEventType = "created" | "status" | "finished" | "removed";

export interface WorkerEvent {
  type: WorkerEventType;
  address: string;
  task_id?: string | null;
  /** Present on status events. */
  status?: string | null;
  blocked_kind?: string | null;
  /** Present on status events: outstanding asks needing the human. */
  elicitations?: WorkerElicitation[];
  exit_code?: number | null;
  parent?: string | null;
  turn?: number;
}

export interface WorkerEventSubscription {
  stop(): void;
}

export interface WorkerModel { id: string; label: string; reasoning: string[] }

export interface WorkerBackend {
  name: string;

  /** Start an agent for a task (worktrees included when start.git is set). */
  start(start: WorkerStart): Promise<WorkerSession>;
  list(): Promise<WorkerSession[]>;
  get(address: string): Promise<WorkerSession | null>;
  /** Recent output (screen + history) as plain text. */
  read(address: string, lines: number): Promise<string>;
  /** Deliver input to a live session (reply to a question). */
  send(address: string, text: string): Promise<void>;
  /** Answer a structured ask (elicitation) directly: accept/decline/cancel. */
  resolveElicitation(
    address: string,
    elicitationId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<void>;
  kill(address: string): Promise<void>;
  /** Archive a resolved session without deleting its worktree. */
  archive?(address: string): Promise<void>;
  /** Remove the worktree a finished task created (best effort). */
  cleanup?(address: string): Promise<void>;
  /** Session transcript — for the context drawer and handoff synthesis. */
  history(address: string): Promise<string>;
  /** Session tree: top-level sessions with children (task attribution). */
  tree(): Promise<{ address: string; children: string[] }[]>;
  /** Where to inspect this session in the backend's own UI (null = none). */
  inspectUrl?(address: string): string | null;
  /** Harness dimension of the backend's registry (for target pickers). */
  registryAgents?(): Promise<{ id: string; name: string }[]>;
  harnesses?(): Promise<{ harness: string; agents: { id: string; name: string }[]; models?: WorkerModel[] }[]>;
  onEvent(cb: (e: WorkerEvent) => void): WorkerEventSubscription;
}
