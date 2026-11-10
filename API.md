# Corral HTTP API contract (v1)

Base: `http://127.0.0.1:4787`. Auth: every `/api/*` route except `/api/health` requires
either `Authorization: Bearer <token>` or the `corral_token` cookie. The web app is
served at `/`; visiting `/?token=<token>` sets the cookie and redirects to `/`.
On 401 the UI shows a token-entry screen (send the token as `?token=` once).

Live updates: `GET /api/events` (SSE). Events: `event: item.created|item.updated|task.updated|session.updated|pulls.updated`
with the entity JSON as `data`. Use `item.created` for desktop notifications.

Page-load endpoints never wait on a third party indefinitely: per-session lookups give up
after 3s (`/api/tasks`), the session list after 4s, the harness registry after 6s, and the
OpenCode Go quota after 2.5s. The response then carries last-known data or a note, so a
stalled dependency degrades the page instead of hanging it.

Static hosting: `/assets/*` (Vite content-hashed) is `Cache-Control: public, max-age=31536000,
immutable`; the shell, `sw.js` and the other root files are `no-cache` with an `ETag`, so a
reload is a 304 unless a deploy replaced them.

## Entities

```ts
type Task = {
  id: string; title: string; prompt: string; repo_path: string;
  kind: "code" | "review";    // review: review pr_url, no branch, no PR loop
  pr_url: string | null;      // the task's PR, or the reviewed PR/MR for kind "review"
  target: string;             // "", "claude", "codex", "opencode"
  target_state: "suggested" | "confirmed";
  base_branch: string | null; branch: string | null; worktree_path: string | null;
  assignee: string | null;
  jira_key: string | null; jira_url: string | null; jira_parent_key: string | null;
  status: "open" | "dispatched" | "done" | "archived";
  terminal_address: string | null; exit_code: number | null;
  created_ms: number; updated_ms: number;
};

type Item = {
  id: string;
  kind: "question" | "pr" | "digest";
  status: "open" | "resolved" | "archived";
  title: string;
  summary: string;   // structured summary ("" until summarized)
  body: string;      // raw tail / structured body — shown when summary is empty
  source_ref: string | null;   // herdr terminal address for question items
  task_id: string | null;
  structured: number;          // 1 = agent reported it, 0 = blocked-status fallback
  created_ms: number; updated_ms: number;
  resolved_ms: number | null; snooze_until_ms: number | null;
};

```

## Endpoints

### Inbox
- `GET /api/items?status=open|resolved|archived&kind=question|pr|digest` → `Item[]` (newest first)
- `POST /api/items/:id/reply` `{text}`, `{permission}`, or `{content}` → `{ok, sent_to}` — replies to the agent and resolves the item. For structured question batches, `content` maps each question ID to a string (single choice/custom answer) or nonempty string array (multiple selections); every question must be answered. Single-choice questions also accept `{text}`. Permission choices are `approve`, `reject`, `session`, or `always`; scoped choices require an offered pattern. 400 for invalid/incomplete answers; 409 if no terminal is linked or the elicitation item is not open.
- `POST /api/items/:id/summarize` → `Item` — LLM summary of `body` into `summary` (async, may take ~10s)
- `POST /api/items/:id/resolve` → `Item`
- `POST /api/items/:id/archive` → `Item`
- `POST /api/items/:id/snooze` `{until_ms?}` → `Item` (default +1h)
- `POST /api/prs/sync` → `{ok, ran}` — starts a background re-check of every dispatched/done task with a known PR (throttled to once per 30s; `ran: false` when skipped). A merged PR completes the task and archives all its items; a closed one resolves the PR item. Updates are broadcast as PRs are re-checked.

### Tasks
- `GET /api/harnesses` → `{harnesses, agents}` — available harness groups, their model catalogs (when supported by the worker), and the full worker agent registry. 504 when the worker backend does not answer within 6s (retry shortly).
- `GET /api/tasks?status=open|dispatched|done|archived` → `(Task & {session_model: string | null, session_reasoning: string | null})[]` — linked session settings reported by the worker, or null when unavailable
- `POST /api/tasks` `{title?, prompt?, kind?, pr_url?, repo_path?, target?, model?, reasoning?, base_branch?, assignee?, jira_key?, jira_url?, jira_parent_key?}` → `Task` — title or prompt required; an empty title is filled from the omnigent session title after dispatch. `kind: "review"` requires `pr_url` (GitHub pull or GitLab MR URL); the title defaults to `Review <pr_url>`
- `PATCH /api/tasks/:id` partial task → `Task` — `kind` is fixed at creation and ignored
- `POST /api/tasks/:id/dispatch` `{target?, use_worktree?, agent?, model?, reasoning?}` → `{address, worktreePath, branch}` — uses saved model and reasoning when omitted; creates worktree + starts the agent (409 if already dispatched, 400 if no target). A review task runs on `claude` only (400 otherwise), in `repo_path` with no worktree and no branch (`branch: ""`), with the `skills/review.md` convention: drafts first, publish after the human approves in the inbox
- `POST /api/tasks/:id/cleanup` → `{ok}` — removes the task's worktree

### Jira
- `GET /api/jira/search?q=<text or jql>` → `[{title, prompt, jira_key, jira_url, jira_parent_key, jira_status, repo_path, repo_name, existing_task_id, fingerprint}]` — `repo_*` is the repo the import would target (null when no prefix mapping), `existing_task_id` is set when the issue is already imported (import skips it), `fingerprint` hashes the fields the import would write
- `POST /api/jira/import` `{items: [{key, fingerprint, repo_path?, base_branch?, target?, agent?, model?, reasoning?}]}` (or `{keys: string[]}`, no fingerprint check) → `{created: Task[], changed: SearchResult[], skipped: string[], failed: string[]}` — optional settings are saved on each imported task; omitted repo uses the Jira prefix mapping. An item whose fingerprint no longer matches the issue (content or repo mapping changed since search) lands in `changed` with its current preview and is not imported; keys with an existing task land in `skipped`.
- `POST /api/jira/tasks/:id/done` `{transition_id?}` → `{ok, transition}` — auto-picks a done-like transition when omitted
- `POST /api/jira/tasks/:id/comment` `{text}` → `{ok}`

### Usage
- `GET /api/usage?range=24h|7d|30d|all[&refresh=1]` → Claude Code, Codex and OpenCode Go usage from local session data
  - `pr_additions` is an asynchronously refreshed all-time snapshot of unique task-linked PR/MR diffs, with available and total counts; it is independent of `range`.
  (`~/.claude/projects`, `~/.codex/sessions`): `{range, since_ms, generated_ms, scanning, quota: AgentQuota[],
  totals, by_agent[], by_model[], timeline[], bucket: "hour"|"day", efficiency}`. Cost is an API-list-price
  estimate; models without a price count tokens only (`unpriced_calls`). Shared prices are in
  `DEFAULT_PRICES` in `server/usage.ts`, with optional overrides via `usage.prices` in config.json (`{"gpt-6*": {input, output, cacheRead?, cacheWrite5m?, cacheWrite1h?}}`, USD/MTok). Models without a reliable published price remain unpriced.
  PR additions include all-time current diff totals and `by_project`, `by_model` (configured task model; empty means unpinned), and `by_task` groups. Each group deduplicates linked PR URLs; shared PRs can appear in multiple groups. Availability counts identify incomplete data.
  Claude quota comes from ccstatusline's cache, Codex quota from its latest `rate_limits` event, and OpenCode Go quota from its account usage endpoint using OpenCode's locally registered credential. The Go snapshot is cached for 60s (shared across concurrent polls) and a slow unreachable upstream yields an `AgentQuota` note instead of delaying the report.
  `scanning: true` while the first log scan runs (poll). Spend is attributed to a task when the session
  cwd is inside its `worktree_path`; `efficiency` = done tasks per $ and $ per done task.

### Misc
- `GET /api/reports` is not a route; agents POST structured questions to `POST /api/reports` `{task_id?, terminal?, kind, title, body}` → `Item`. A `done` report on a review task creates a `digest` item (no PR gate); review tasks are never PR-synced
- `GET /api/metrics/summary` → `{by_name: [{name, count, last_ms}], recent: [{id, ts, name, ref, data}]}`
- `GET /api/terminals` → tracked terminals `[{address, task_id, name, agent, last_status, last_turn, updated_ms}]`
- `GET /api/config` → `{port, host, agents: string[], assistant, herdrSocket, worktreesDir, jiraConfigured, jiraJql, favorites: Favorite[], token /* masked */}`
- `Favorite` is `{name, harness, agent, model, reasoning}`; all fields are strings, with empty agent/model/reasoning meaning defaults.
- `PUT /api/config` `{jira?: {baseUrl, email, token, jql}, assistant?: string[], agents?: {...}, favorites?: Favorite[]}` → `{ok}`
- `GET /api/health` → `{ok: true}` (no auth)

- `GET /api/errors` → current background synchronization errors (`source`, `message`, `updated_ms`); cleared when the operation succeeds.

### Benchmarks

- `GET /api/benchmarks` returns the last persisted snapshot as `{ fetched_ms, results }`, or an empty snapshot before the first sync.
- `POST /api/benchmarks/sync` fetches published SWE-bench and Terminal-Bench 4.0 results and replaces the snapshot only after both sources succeed. Results identify their source and report the publisher's agent, model, reasoning level (when disclosed), score and date.
