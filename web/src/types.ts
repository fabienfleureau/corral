// Entity types — mirrors API.md exactly.

export type Task = {
  id: string;
  title: string;
  prompt: string;
  /** "review": review the existing PR/MR in pr_url; no branch, no PR.
   *  "ops": work in a folder and report back; no branch, no PR. */
  kind?: "code" | "review" | "spec" | "analysis" | "ops";
  /** The spec task a code task was created from (multi-repo). */
  parent_task_id?: string | null;
  repo_path: string;
  target: string; // "", "claude", "codex", "opencode"
  target_state: "suggested" | "confirmed";
  agent: string | null;
  model: string | null;
  reasoning: string | null;
  session_model: string | null;
  session_reasoning: string | null;
  /** Files attached to the prompt (absent in a task just created). */
  attachment_count?: number;
  base_branch: string | null;
  branch: string | null;
  worktree_path: string | null;
  assignee: string | null;
  jira_key: string | null;
  jira_url: string | null;
  jira_parent_key: string | null;
  pr_url: string | null;
  jira_status?: string | null;
  epic_id?: string | null;
  /** 1 once the ticket left its epic in Jira. */
  epic_out?: number;
  /** Resolved review command, frozen at dispatch; null when none. */
  review: string | null;
  status: "open" | "dispatched" | "done" | "archived";
  terminal_address: string | null;
  exit_code: number | null;
  created_ms: number;
  updated_ms: number;
};

export type Item = {
  id: string;
  kind: "question" | "pr" | "digest" | "plan" | "launch" | "amendment";
  status: "open" | "resolved" | "archived";
  title: string;
  summary: string; // structured summary ("" until summarized)
  body: string; // raw tail / structured body — shown when summary is empty
  context: string; // raw agent output captured at report time (context drawer)
  options: string | null; // JSON array of quick-reply options
  elicitation: string | null;
  source_ref: string | null; // herdr terminal address for question items
  task_id: string | null;
  structured: number; // 1 = agent reported it, 0 = blocked-status fallback
  ready: number; // for pr items: 1 = review gate passes (threads resolved, checks green)
  handling: number; // for pr items: 1 = the agent has the PR work in flight
  created_ms: number;
  updated_ms: number;
  resolved_ms: number | null;
  snooze_until_ms: number | null;
};

export type SessionInfo = {
  address: string;
  name: string | null;
  agent: string | null;
  task_id: string | null;
  task_title: string | null;
  status: string | null; // working | blocked | idle | done | error | null
  state: string; // live | finished | unknown
  turn: number;
  cwd: string;
  created_ms: number;
  updated_ms: number;
  exit_code: number | null;
};

/** One entry of a task's history (see server/task-events.ts). */
export type TaskEventKind =
  | "created"
  | "updated"
  | "status"
  | "prompt"
  | "question"
  | "jira"
  | "pr"
  | "session";

export type TaskEvent = {
  id: number;
  task_id: string;
  ts: number;
  kind: TaskEventKind;
  message: string;
  /** JSON object with the detail behind the message, or null. */
  data: string | null;
};

/** One event on the daily page, with its task and session context. */
export type DailyActivity = TaskEvent & {
  title: string;
  prompt: string;
  repo_name: string;
  repo_path: string;
  jira_url: string | null;
  jira_key: string | null;
  pr_url: string | null;
  terminal_address: string | null;
  session_url: string | null;
};

export type PullColor = "green" | "orange" | "red";

export type Pull = {
  id: string;
  host: "github" | "gitlab";
  number: number;
  title: string;
  url: string;
  repo: string;
  state: string; // open | draft | merged | closed
  author: string;
  isMine: boolean;
  awaitingMe: boolean;
  color: PullColor;
  reason: string;
  updated_ms: number;
};

export type JiraSearchResult = {
  title: string;
  prompt: string;
  jira_key: string;
  jira_url: string;
  jira_parent_key: string | null;
  jira_status: string | null;
  /** Repo the import would target (by Jira key prefix); null when unmapped. */
  repo_path: string | null;
  repo_name: string | null;
  /** Set when a task for this issue exists; import skips it. */
  existing_task_id: string | null;
  /** Hash of the fields import would write; import refuses the issue if it changed. */
  fingerprint: string;
};

export type JiraImportResult = {
  created: Task[];
  /** Issues whose content or repo mapping changed since review; not imported. */
  changed: JiraSearchResult[];
  /** Keys that already had a task. */
  skipped: string[];
  failed: string[];
};

export type Repo = {
  id: string;
  name: string;
  path: string;
  jira_prefix: string | null;
  /** null reads as professional. */
  context: Context | null;
  source: "manual" | "scan";
  created_ms: number;
};

export type Context = "professional" | "personal";
export type Favorite = { name: string; harness: string; agent: string; model: string; reasoning: string; context: Context; review: string };
export type Reviewer = { name: string; command: string };

export type Config = {
  favorites: Favorite[];
  reviewers: Reviewer[];
  port: number;
  host: string;
  agents: string[];
  assistant: string;
  backend: string;
  /** Model facts the user edited (merged over the shipped defaults). */
  models: ModelCatalog;
  omnigentUrl: string;
  jiraConfigured: boolean;
  jiraJql: string;
  token: string; // masked
};

// ---- model facts (GET /api/models) ----

export type Retention = "none" | "30d" | "trains" | "unknown";

/** One reasoning level's measured facts. */
export type EffortFacts = {
  /** Artificial Analysis Intelligence Index. */
  index?: number;
  /** USD per task. */
  costPerTask?: number;
  /** Wall-clock minutes per task. */
  minPerTask?: number;
};

export type ModelFacts = {
  retention: Retention;
  quota?: { monthlyUsd: number };
  /** Key = the reasoning value the harness reports; "default" is the fallback. */
  efforts?: Record<string, EffortFacts>;
  bench?: Record<string, number>;
  /** YYYY-MM-DD the numbers were collected. */
  asOf: string;
  source?: string;
};

/** Model id (exact, or "prefix*") -> facts. */
export type ModelCatalog = Record<string, ModelFacts>;

/** GET /api/models/availability: what a local model server answered. */
export type ModelAvailability = {
  /** "up": it listed its models. "down": it refused or errored. "unknown": no answer in time. */
  status: "up" | "down" | "unknown";
  models: string[];
};

// ---- usage page (GET /api/usage) ----

export type UsageAgent = "claude" | "codex" | "opencode-go";
export type UsageRange = "24h" | "7d" | "30d" | "all";

export type UsageTotals = {
  calls: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  unpriced_calls: number;
};

export type AgentQuota = {
  agent: UsageAgent | "opencode-go";
  source: string;
  as_of_ms: number | null;
  stale: boolean;
  plan: string | null;
  windows: { label: string; used_percent: number; resets_ms: number | null }[];
  note: string | null;
};

export type UsageReport = {
  pr_additions: { data: { additions: number; available: number; total: number; by_project: PrAdditionsGroup[]; by_model: PrAdditionsGroup[]; by_task: PrAdditionsGroup[] } | null; scanning: boolean };
  range: UsageRange;
  since_ms: number | null;
  generated_ms: number;
  scanning: boolean;
  quota: AgentQuota[];
  totals: UsageTotals;
  by_agent: ({ agent: UsageAgent } & UsageTotals)[];
  by_model: ({ agent: UsageAgent; model: string; priced: boolean } & UsageTotals)[];
  timeline: { start_ms: number; claude: number; codex: number; claude_tokens: number; codex_tokens: number; opencode_go: number; opencode_go_tokens: number; models: { agent: UsageAgent; model: string; cost_usd: number; tokens: number }[] }[];
  bucket: "hour" | "day";
  efficiency: {
    tasks_with_spend: number;
    tasks_done: number;
    attributed_usd: number;
    unattributed_usd: number;
    tasks_per_usd: number | null;
    usd_per_done_task: number | null;
    top_tasks: { id: string; title: string; status: string; agent: UsageAgent | "mixed"; cost_usd: number; tokens: number }[];
  };
};

// ---- platform API rate limits (GET /api/rate-limits) ----

/** One GitHub resource (core, search, graphql) or the GitLab API throttle. */
export type RateLimitWindow = { name: string; limit: number; remaining: number; reset_ms: number | null };

export type PlatformRateLimit = {
  host: "github" | "gitlab";
  /** Empty when the fetch failed; `note` says why. */
  windows: RateLimitWindow[];
  note: string | null;
  fetched_ms: number;
};

export interface PrAdditionsGroup { key: string; additions: number; available: number; total: number }


export type EpicTaskState = "out" | "merged" | "pr_ready" | "pr_open" | "running" | "ready" | "blocked";

export type EpicSummary = { total: number; merged: number; testable: number; ready: number; blocked: number };

export type Epic = {
  id: string;
  jira_key: string;
  title: string;
  description: string;
  error: string | null;
  /** Favorite and working directory saved for requests on this epic. */
  favorite_name?: string | null;
  repo_path?: string | null;
  synced_ms: number;
  created_ms: number;
};

export type EpicTaskView = {
  task: Task;
  state: EpicTaskState;
  blockers: { key: string; task_id: string | null; satisfied: boolean }[];
  alert: string | null;
  testable: boolean;
  stack_on: string | null;
  /** Started on an older design than the current one, and not merged. */
  impacted?: boolean;
};

export type EpicDesign = { epic_id: string; version: number; body: string; reason: string; author: string; created_ms: number };

export type EpicDetail = {
  /** Set when the server answered an import/sync failure as JSON. */
  error?: string | null;
  epic: Epic;
  tasks: Task[];
  links: { task_key: string; blocked_by_key: string }[];
  views: EpicTaskView[];
  summary: EpicSummary;
  design: EpicDesign | null;
  design_versions: number;
  /** Proposed amendments waiting in the inbox. */
  amendments: { id: string; task_id: string; design_version: number; body: string }[];
};
