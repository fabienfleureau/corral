// Entity types — mirrors API.md exactly.

export type Task = {
  id: string;
  title: string;
  prompt: string;
  /** "review": review the existing PR/MR in pr_url; no branch, no PR. */
  kind?: "code" | "review";
  repo_path: string;
  target: string; // "", "claude", "codex", "opencode"
  target_state: "suggested" | "confirmed";
  agent: string | null;
  model: string | null;
  reasoning: string | null;
  session_model: string | null;
  session_reasoning: string | null;
  base_branch: string | null;
  branch: string | null;
  worktree_path: string | null;
  assignee: string | null;
  jira_key: string | null;
  jira_url: string | null;
  jira_parent_key: string | null;
  pr_url: string | null;
  status: "open" | "dispatched" | "done" | "archived";
  terminal_address: string | null;
  exit_code: number | null;
  created_ms: number;
  updated_ms: number;
};

export type Item = {
  id: string;
  kind: "question" | "pr" | "digest";
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
  source: "manual" | "scan";
  created_ms: number;
};

export type Favorite = { name: string; harness: string; agent: string; model: string; reasoning: string };

export type Config = {
  favorites: Favorite[];
  port: number;
  host: string;
  agents: string[];
  assistant: string;
  backend: string;
  omnigentUrl: string;
  jiraConfigured: boolean;
  jiraJql: string;
  token: string; // masked
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
  timeline: { start_ms: number; claude: number; codex: number; claude_tokens: number; codex_tokens: number; opencode_go: number; opencode_go_tokens: number }[];
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

export interface PrAdditionsGroup { key: string; additions: number; available: number; total: number }

export interface BenchmarkResult { id: string; benchmark: string; agent: string; model: string; reasoning: string | null; score: number; date: string | null; source: string }
export interface BenchmarkSnapshot { fetched_ms: number | null; results: BenchmarkResult[] }
