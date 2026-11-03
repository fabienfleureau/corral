# Corral HTTP API contract (v1)

Base: `http://127.0.0.1:4787`. Auth: every `/api/*` route except `/api/health` requires
either `Authorization: Bearer <token>` or the `corral_token` cookie. The web app is
served at `/`; visiting `/?token=<token>` sets the cookie and redirects to `/`.
On 401 the UI shows a token-entry screen (send the token as `?token=` once).

Live updates: `GET /api/events` (SSE). Events: `event: item.created|item.updated|task.updated|idea.created`
with the entity JSON as `data`. Use `item.created` for desktop notifications.

## Entities

```ts
type Task = {
  id: string; title: string; prompt: string; repo_path: string;
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

type Idea = {
  id: string; text: string;
  tag: "workflow" | "product";
  origin: "user" | "agent";
  status: "new" | "promoted" | "dismissed";
  created_ms: number;
};
```

## Endpoints

### Inbox
- `GET /api/items?status=open|resolved|archived&kind=question|pr|digest` → `Item[]` (newest first)
- `POST /api/items/:id/reply` `{text}` → `{ok, sent_to}` — sends text to the item's terminal (hc send) and resolves the item. 409 if no terminal linked.
- `POST /api/items/:id/summarize` → `Item` — LLM summary of `body` into `summary` (async, may take ~10s)
- `POST /api/items/:id/resolve` → `Item`
- `POST /api/items/:id/archive` → `Item`
- `POST /api/items/:id/snooze` `{until_ms?}` → `Item` (default +1h)
- `POST /api/prs/sync` → `{ok, ran}` — re-checks every dispatched/done task with a known PR now (throttled to once per 30s; `ran: false` when skipped). A merged PR archives the task and all its items; a closed one resolves the PR item.

### Tasks
- `GET /api/tasks?status=open|dispatched|done|archived` → `Task[]`
- `POST /api/tasks` `{title?, prompt?, repo_path?, target?, base_branch?, assignee?, jira_key?, jira_url?, jira_parent_key?}` → `Task` — title or prompt required; an empty title is filled from the omnigent session title after dispatch
- `PATCH /api/tasks/:id` partial task → `Task`
- `POST /api/tasks/:id/dispatch` `{target?, use_worktree?}` → `{address, worktreePath, branch}` — creates worktree + starts the agent (409 if already dispatched, 400 if no target)
- `POST /api/tasks/:id/cleanup` → `{ok}` — removes the task's worktree

### Jira
- `GET /api/jira/search?q=<text or jql>` → `[{title, prompt, jira_key, jira_url, jira_parent_key, jira_status, repo_path, repo_name, existing_task_id, fingerprint}]` — `repo_*` is the repo the import would target (null when no prefix mapping), `existing_task_id` is set when the issue is already imported (import skips it), `fingerprint` hashes the fields the import would write
- `POST /api/jira/import` `{items: [{key, fingerprint}]}` (or `{keys: string[]}`, no fingerprint check) → `{created: Task[], changed: SearchResult[], skipped: string[], failed: string[]}` — an item whose fingerprint no longer matches the issue (content or repo mapping changed since search) lands in `changed` with its current preview and is not imported; keys with an existing task land in `skipped`
- `POST /api/jira/tasks/:id/done` `{transition_id?}` → `{ok, transition}` — auto-picks a done-like transition when omitted
- `POST /api/jira/tasks/:id/comment` `{text}` → `{ok}`

### Ideas
- `GET /api/ideas?status=new|promoted|dismissed` → `Idea[]`
- `POST /api/ideas` `{text, tag?, origin?}` → `Idea`
- `PATCH /api/ideas/:id` `{status?, tag?}` → `{ok}`

### Misc
- `GET /api/reports` is not a route; agents POST structured questions to `POST /api/reports` `{task_id?, terminal?, kind, title, body}` → `Item`
- `GET /api/metrics/summary` → `{by_name: [{name, count, last_ms}], recent: [{id, ts, name, ref, data}]}`
- `GET /api/terminals` → tracked terminals `[{address, task_id, name, agent, last_status, last_turn, updated_ms}]`
- `GET /api/config` → `{port, host, agents: string[], assistant, herdrSocket, worktreesDir, jiraConfigured, jiraJql, token /* masked */}`
- `PUT /api/config` `{jira?: {baseUrl, email, token, jql}, assistant?: string[], agents?: {...}}` → `{ok}`
- `GET /api/health` → `{ok: true}` (no auth)
