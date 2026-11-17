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

Unknown `/api/*` paths answer `404 {"error":"unknown endpoint: <METHOD> <path>"}`. The SPA
shell is never served under `/api/*`, so a server older than the page reports a missing
endpoint instead of returning HTML the client would fail to parse.

## Entities

```ts
type Task = {
  id: string; title: string; prompt: string; repo_path: string;
  kind: "code" | "review" | "spec"; // review: review pr_url, no branch, no PR loop; spec: multi-repo step one (repo_path is a folder of sub-projects)
  parent_task_id: string | null; // the spec task a code task was created from; its contract is appended to the prompt at dispatch
  spec: string | null;        // spec tasks: JSON {contract, subtasks:[{repo,title,prompt}], children?}
  pr_url: string | null;      // the task's PR, or the reviewed PR/MR for kind "review"
  review: string | null;      // resolved review command, frozen at dispatch (code tasks)
  target: string;             // "", "claude", "codex", "opencode"
  target_state: "suggested" | "confirmed";
  base_branch: string | null; branch: string | null; worktree_path: string | null;
  assignee: string | null;
  jira_key: string | null; jira_url: string | null; jira_parent_key: string | null;
  jira_status: string | null; // Jira status last reached by the status sync (cached; written by the sync)
  status: "open" | "dispatched" | "done" | "archived";
  terminal_address: string | null; exit_code: number | null;
  created_ms: number; updated_ms: number;
};

type Item = {
  id: string;
  kind: "question" | "pr" | "digest" | "plan" | "launch" | "amendment"; // launch: a task whose epic prerequisites are ready
  status: "open" | "resolved" | "archived";
  title: string;
  summary: string;   // structured summary ("" until summarized)
  body: string;      // raw tail / structured body — shown when summary is empty
  source_ref: string | null;   // herdr terminal address for question items
  task_id: string | null;
  structured: number;          // 1 = agent reported it, 0 = fallback: the session blocked, or its run ended (idle/error) with no report
  ready: number;               // pr items: 1 = review gate passes (threads resolved, checks green)
  handling: number;            // pr items: 1 = the agent has the PR work in flight
  created_ms: number; updated_ms: number;
  resolved_ms: number | null; snooze_until_ms: number | null;
};

```

## Endpoints

### Daily activity
- `GET /api/daily?start=<ms>&end=<ms>` → task history events in the half-open timestamp interval, joined to registered professional repositories (including legacy null contexts). Each event carries the task title, prompt, repo name/path, Jira and PR links, terminal address and `session_url` (omnigent's session inspect URL when available). The interval must be positive and at most 25 hours. Tasks with an unknown repository are excluded.
- `POST /api/daily/summarize` `{start, end, date, favorite}` → `{task}` — starts an `analysis` task that summarizes the day's activity and reports the markdown to the inbox. `favorite` must name a configured professional favorite; its harness, agent, model and reasoning are used for the dispatch. The task runs without a worktree in the repository of the day's first event. 400 for an invalid interval/date/favorite, 409 when the day has no activity.

### Inbox
- `GET /api/items?status=open|resolved|archived&kind=question|pr|digest|plan|launch|amendment` → `Item[]` (newest first)
- `POST /api/items/:id/reply` `{text}`, `{permission}`, or `{content}` → `{ok, sent_to}` — replies to the agent and resolves the item. For structured question batches, `content` maps each question ID to a string (single choice/custom answer) or nonempty string array (multiple selections); every question must be answered. Single-choice questions also accept `{text}`. Permission choices are `approve`, `reject`, `session`, or `always`; scoped choices require an offered pattern. 400 for invalid/incomplete answers; 409 if no terminal is linked or the elicitation item is not open.
- `POST /api/items/:id/summarize` → `Item` — LLM summary of `body` into `summary` (async, may take ~10s)
- `POST /api/items/:id/resolve` → `Item`
- `POST /api/items/:id/archive` → `Item`
- `POST /api/items/:id/snooze` `{until_ms?}` → `Item` (default +1h)
- `POST /api/prs/sync` → `{ok, ran}` — starts a background re-check of every dispatched/done task with a known PR (throttled to once per 30s; `ran: false` when skipped). A merged PR completes the task and archives all its items; a closed one resolves the PR item. Updates are broadcast as PRs are re-checked. Each successful check also stores the last observed state in the task's `pr_meta.pr` (`state`, `mergeable`, `checks`, unresolved `threads` ids/count, readiness `reasons`, `checked_ms`) without changing `updated_ms`; it is evidence for the improvement digest, not task activity.

### Tasks
- `GET /api/harnesses` → `{harnesses, agents}` — available harness groups, their model catalogs (when supported by the worker), and the full worker agent registry. 504 when the worker backend does not answer within 6s (retry shortly).
- `GET /api/tasks?status=open|dispatched|done|archived` → `(Task & {session_model: string | null, session_reasoning: string | null, attachment_count: number})[]` — linked session settings reported by the worker, or null when unavailable; `attachment_count` is the number of files attached to the prompt. A session the worker reports as `finished` is read once and kept (see `server/session-facts.ts`); live sessions — including a `done` task whose session is still running — are refreshed through one shared pass per burst of requests, so a queue of a few hundred tasks answers in milliseconds instead of one round trip per task
- `POST /api/tasks` `{title?, prompt?, kind?, pr_url?, repo_path?, target?, model?, reasoning?, base_branch?, assignee?, jira_key?, jira_url?, jira_parent_key?, attachments?}` → `Task` — title or prompt required; an empty title is filled from the omnigent session title after dispatch. `kind: "review"` requires `pr_url` (GitHub pull or GitLab MR URL); the title defaults to `Review <pr_url>`. `kind: "spec"` (multi-repo) requires a prompt and `repo_path` = an existing folder (not a git repo) holding the sub-projects
- `POST /api/tasks` `attachments: {filename, content_type, data}[]` — files for the prompt, `data` base64. At most 10 files and 25 MB together; per file 5 MB for a PNG, JPEG, GIF or WebP image, 20 MB for a PDF, 10 MB for text or code (an SVG counts as text; the extension rescues a text file the browser mislabelled). Checked before anything is stored, so a bad file creates no task: 415 for an unsupported type, 413 for a size, 400 for a malformed entry. Stored with the task and sent to the agent with the first prompt at dispatch (omnigent uploads each file to the session and references it from the message as `input_image` / `input_file`). This is the one route whose request body may exceed 2 MB (about 34 MB)
- `GET /api/tasks/:id/attachments` → `{id, task_id, filename, content_type, bytes, created_ms}[]` — the task's attachments in drop order, without their bytes. 404 for an unknown task
- `POST /api/tasks/:id/approve-plan` → `{children: Task[]}` — approves a spec task's plan: creates one `code` task per sub-task (`repo_path` = the sub-repo, registered if unknown, `parent_task_id` = the spec task, target copied), marks the spec task done and resolves its `plan` item. 400 if the task is not a spec, has no plan, was already approved, or a sub-task repo no longer validates
- `PATCH /api/tasks/:id` partial task → `Task` — `kind` is fixed at creation and ignored
- `POST /api/tasks/:id/archive-session` → `Task` — archives the session and then the dispatched task; leaves the task unchanged if session archiving fails
- `POST /api/tasks/:id/dispatch` `{target?, use_worktree?, agent?, model?, reasoning?, review?}` → `{address, worktreePath, branch}` — uses saved model and reasoning when omitted; creates worktree + starts the agent (409 if already dispatched, 400 if no target). `review` is a reviewer name from `GET /api/config` `reviewers`; its command (with `{base_branch}` replaced by the task's base branch or the repo's default) is appended to the prompt and frozen on the task. A review task runs on `claude` only (400 otherwise), in `repo_path` with no worktree and no branch (`branch: ""`), with the `skills/review.md` convention: drafts first, publish after the human approves in the inbox. Best effort, never fails or delays the dispatch: a `code` task linked to a Jira ticket (`jira_key`) moves that ticket to "In Progress"
- `GET /api/tasks/:id/events[?limit=500]` → `TaskEvent[]` — the task's history, oldest first: `{id, task_id, ts, kind, message, data}`. `kind` is one of `created`, `updated`, `status`, `prompt`, `question`, `jira`, `pr`, `session`; `message` is the one-line sentence the inbox modal shows, `data` a JSON object with the detail behind it (`text` for a prompt, `from`/`to`, `pr`, `key`, …) or null. History is append-only and recorded by the server as things happen (creation, edits, state changes, every prompt sent to the agent, Jira moves, PR milestones, agent questions); a task that predates the log gets one `created` entry backfilled at startup. `limit` keeps the newest N (default 500, max 2000). 404 for an unknown task.
- `POST /api/tasks/:id/cleanup` → `{ok}` — removes the task's worktree
- `POST /api/tasks/:id/check-pr` `{force?}` → `{pr, task, delivered}` — re-checks one task's PR/MR now and applies the needed changes: the task's `pr_url`, its inbox item, and any review comments or merge conflicts handed to the agent. `pr` is null when no PR/MR exists for the branch yet. `force: true` (the inbox "Force refresh" button) re-hands comments and conflicts the PR loop already pushed — for a hand-off that did not land — and waits for it; `delivered` is `{address, comments, conflict}` when the loop had work for the agent (`address` null when the hand-off failed), else null (an automatic check always reports null). 400 for a review task or a task without a branch.

### Jira
- `GET /api/jira/search?q=<text or jql>` → `[{title, prompt, jira_key, jira_url, jira_parent_key, jira_status, repo_path, repo_name, existing_task_id, fingerprint}]` — `repo_*` is the repo the import would target (null when no prefix mapping), `existing_task_id` is set when the issue is already imported (import skips it), `fingerprint` hashes the fields the import would write
- `POST /api/jira/import` `{items: [{key, fingerprint, repo_path?, base_branch?, target?, agent?, model?, reasoning?}]}` (or `{keys: string[]}`, no fingerprint check) → `{created: Task[], changed: SearchResult[], skipped: string[], failed: string[]}` — optional settings are saved on each imported task; omitted repo uses the Jira prefix mapping. An item whose fingerprint no longer matches the issue (content or repo mapping changed since search) lands in `changed` with its current preview and is not imported; keys with an existing task land in `skipped`. The issue's current status is stored on the task (`jira_status`) as the starting point of the status sync.
- `GET /api/epics` → `(Epic & {summary})[]` — `summary` is `{total, merged, testable, ready, blocked}`; `Epic` is `{id, jira_key, title, description, error, synced_ms, created_ms}`; `description` is the epic's Jira text (the design), `error` a sync problem such as a dependency cycle
- `POST /api/epics` `{key}` → `{epic, created, updated, out, tasks, links}` — import a Jira epic by key, or resync it when known (same call). Children are the tickets whose parent is the epic; each becomes a task (or an existing task for that `jira_key` is attached). `links` are `{task_key, blocked_by_key}` from the Jira "blocks / is blocked by" links between children. A `Repo: <name>` line in a ticket picks the task's repo among the registered ones. A task already dispatched keeps its prompt and title; a ticket that left the epic is flagged `epic_out: 1`, not deleted. 400 on a bad key or no Jira config, 502 on a Jira failure
- `GET /api/epics/:id` → `{epic, tasks, links, views, summary}` — `views` lists the tasks in dependency order as `{task, state, blockers: [{key, task_id, satisfied}], alert, testable, stack_on}`. `state` is `out | merged | pr_ready | pr_open | running | ready | blocked`. A blocker is satisfied when its task is merged (or its Jira ticket Done), or its PR item is green and ready. `ready` = every blocker satisfied. A ready task waits on the Epic page: syncs create no inbox item and start no agent. 404 when unknown
- `POST /api/epics/:id/tasks/:taskId/launch` → `{address, worktreePath, branch}` — starts a ready epic task from the Epic page. Rechecks that the task is in the epic and still `ready` (409 otherwise), 400 without a harness or repo, then sets `base_branch` to the prerequisite's branch when exactly one same-repo prerequisite is unmerged and dispatches with the task's saved settings. Archives any `launch` item left by an older Corral version. 404 for an unknown epic or task
- `POST /api/epics/:id/orchestrate` `{request}` → `{proposal}` — ask the assistant for a plan using the epic design, task states and dependencies. No changes are applied. 400 for an empty or overlong request, 404 for an unknown epic, 502 if the assistant fails.
- `POST /api/epics/:id/design` `{body, reason?}` → `EpicDetail` — publish a new design version. v1 is the epic's Jira text at import. The version replaces the single `[corral:begin:design]` block of the Jira epic description (the rest of the description is never touched), then is stored. 409 `{conflict: true}` when that block was edited in Jira, lost its markers or appeared on its own (nothing saved); 400 without `body` or Jira. In the background an assistant proposes one amendment per unstarted task the revision changes: an inbox item of kind `amendment`, nothing written to Jira yet. `GET /api/epics/:id` adds `design`, `design_versions`, `amendments` (proposed) and `impacted` on each view (started on an older design, not merged)
- `POST /api/items/:id/amendment/apply|reject` → `Item` (or `POST /api/amendments/:id/apply|reject` → amendment) — apply writes the amendment into the ticket's `[corral:begin:amendment]` block and onto the task (injected at dispatch after the design); 409 on a conflict or when already handled
- `POST /api/epics/:id/sync` → same body as `POST /api/epics`
- `POST /api/jira/tasks/:id/done` `{transition_id?}` → `{ok, transition}` — auto-picks a done-like transition when omitted
- `POST /api/jira/tasks/:id/comment` `{text}` → `{ok}`

Jira status sync (one-way, forward-only): a task with `jira_key` moves its ticket as it
progresses — dispatch → "In Progress", an open PR/MR found by the PR sync → "Code Review", a PR
Corral itself shows as "ready to merge" (readiness gate passed **and** a human approved it) →
"Ready to merge", a merge → "Done". A PR that merely passed the gate stays at the review status
until a human approval lands. Only transitions the workflow
offers *now* are used; missing intermediate statuses are walked through in order. Status names
are per-workflow (`jira.statuses` in the config file); a blank name disables that stage. The
status last reached is stored on the task (`jira_status`) and is the dedupe, so a periodic PR
sync costs no Jira call. Failures are recorded as `jira.status_failed` metrics and never block
a dispatch or a PR sync.

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
- `GET /api/rate-limits[?refresh=1]` → `{limits: PlatformRateLimit[], fetched_ms}` — remaining GitHub and GitLab API quota for the PR loop, shown on the Usage page. `PlatformRateLimit` is `{host: "github"|"gitlab", windows: [{name, limit, remaining, reset_ms}], note, fetched_ms}`: GitHub contributes `core`, `search` and `graphql` (from `gh api rate_limit`, which spends no quota), GitLab the authenticated throttle (from the `RateLimit-*` headers of one `glab api user` call). A platform that fails to answer returns `windows: []` and a `note` instead of an error. The answer is cached for 60s, shared across concurrent polls; `refresh=1` (the page's Refresh button) bypasses the cache.

### Improvement analysis
- `GET /api/analysis-repo` → `{repo}`; `PUT /api/analysis-repo` `{repo}` persists the git repository used by analyses.
- `GET /api/improvement` → schedule, last attempt/success, error and running state.
- `PUT /api/improvement` `{intervalDays: 0|1|7|30}` → updated state; 0 disables automatic runs.
- `POST /api/improvement/run` → a dispatched analysis task. The agent reports an inbox digest when finished. Concurrent launch requests share one run. The analysis sends bounded evidence to the agent. By default: 60 recent task snapshots plus up to 60 tasks linked from items or task events (so older items keep their task), 300 items, 1500 events with their payloads, persisted PR snapshots (checks, mergeability, unresolved thread counts and gate reasons) and API-equivalent usage cost/token attribution per task from local agent logs. It also includes derived `data_quality` flags (untitled tasks, done tasks without a PR, repeated dispatches, items resolved without a timestamp, duplicate PR items, orphan/malformed task ids, open PR items) and an explicit `gaps` list; caps are reported in `limits`/`truncated`. Production outcomes and review-thread bodies are still not recorded. Scheduled runs catch up after restart and failed runs retry after one hour.

### Engineering skills analysis
- `GET /api/engineering-skills` → analysis status with an independent schedule.
- `PUT /api/engineering-skills` `{intervalDays: 0|1|7|30}` → updated status.
- `POST /api/engineering-skills/run` → a dispatched analysis task. The analysis uses the bounded 30-day Corral activity snapshot, plus clipped and redacted task descriptions and inbox question bodies, to suggest learning topics and exercises. It does not fetch code diffs or review comments, and cannot establish the human's proficiency from delegated work.

### Skills analysis
- `GET /api/skills-analysis` → `{intervalDays, lastSuccessMs, lastAttemptMs, error, running}`, same shape as the improvement analysis, with its own schedule.
- `PUT /api/skills-analysis` `{intervalDays: 0|1|7|30}` → updated state; 0 (the default) disables automatic runs.
- `POST /api/skills-analysis/run` → a dispatched analysis task; the agent reports a digest when finished. A launch failure returns 500 `{error}`. Concurrent launch requests share one run. The agent is instructed to propose only and not modify files. Evidence sent to the assistant, bounded to about 110 KB:
  - **Inventory:** skills from `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills`, the `.claude/skills` and `.agents/skills` of registered repos, and the newest cached version of each Claude plugin skill (`~/.claude/plugins/cache`). Links are followed and duplicates collapsed. Per skill: name, origin (`user`/`project`/`plugin`), location, description (240 chars; 160 for plugins), opening lines (240 chars; not sent for plugin skills), file mtime and size. Caps: 100 owned, 120 plugin skills.
  - **Usage, last 90 days:** counted only from structured invocations: the Claude `Skill` tool, Claude slash commands that match an installed skill, and Codex reads of a `…/skills/<name>/SKILL.md`. The skill listings embedded in transcripts are never counted. Per skill: uses in 30 days and in the window, sessions, last use. Invocations that match no installed skill are listed as `unlisted_invocations`. OpenCode sessions are not scanned.
  - **Coverage:** `coverage_start_ms` is the earliest moment the logs are known to cover; the prompt tells the assistant to say "unused since" that date, since logs get pruned.
  - **Prompts:** the first human message of up to 120 recent sessions, deduplicated, truncated to 280 chars, with Corral's dispatch boilerplate cut and bearer tokens, API keys, URL credentials and long hex strings redacted.
  - **Corral's own runs are excluded:** summaries and both digests run the `assistant` command (`claude -p`), which logs like any session. Sessions whose first prompt opens with one of Corral's prompts (`server/assistant-prompts.ts`) are dropped, prompt and invocations, and counted in `logs.corral_assistant_runs_excluded`. Other headless runs still count.
  Evidence is included in the task prompt. Scheduled runs catch up after restart and failed launches retry after one hour.

### Misc
- `GET /api/reports` is not a route; agents POST structured questions to `POST /api/reports` `{task_id?, terminal?, kind, title, body}` → `Item`. A `plan` report (`{task_id, kind:"plan", title, contract, subtasks:[{repo,title,prompt}]}`, spec tasks only) stores the contract on the task and creates (or refreshes) one open `plan` item; every `repo` must be a git repository root inside the task folder (relative, no `..`, no symlink out; ≤12, no duplicates) or the report is refused with 400. A spec task is dispatched with `skills/spec.md` in `repo_path` itself, no worktree, no branch, no PR sync. A `done` report on a review task creates a `digest` item (no PR gate); review tasks are never PR-synced
- `GET /api/metrics/summary` → `{by_name: [{name, count, last_ms}], recent: [{id, ts, name, ref, data}]}`
- `GET /api/terminals` → tracked terminals `[{address, task_id, name, agent, last_status, last_turn, updated_ms}]`
- `GET /api/config` → `{port, host, agents: string[], assistant, herdrSocket, worktreesDir, jiraConfigured, jiraJql, favorites: Favorite[], reviewers: Reviewer[], models: {[modelId]: ModelFacts}, token /* masked */}` — `models` holds only the user's overrides, not the shipped defaults.
- `ModelFacts` is `{retention: "none"|"30d"|"trains"|"unknown", quota?: {monthlyUsd}, efforts?: {[reasoning]: {index?, costPerTask?, minPerTask?}}, bench?: {[name]: score}, asOf: "YYYY-MM-DD", source?}`. `efforts.default` is the fallback when the harness's reasoning value has no entry.
- `GET /api/models` → `{models: {[modelId]: ModelFacts}}` — the shipped defaults (`server/model-catalog.json`) merged with the config overrides, user entry winning per model key. Keys are the ids the harnesses report (`GET /api/harnesses`), or `prefix*` for ids a harness suffixes with a date or variant; matching is exact id first, then the longest prefix.
- `GET /api/models/availability` → `{providers: {[provider]: {status: "up"|"down"|"unknown", models: string[]}}}` — probes the local model servers configured in `omnigent.localProviders` (`GET <baseUrl>/models`, 2 s timeout, cached 30 s). A probe that does not answer in time is `unknown`, never `down`; an unconfigured provider is `unknown`.
- `Favorite` is `{name, harness, agent, model, reasoning, context, review}`; empty agent/model/reasoning mean defaults, and `review` is a reviewer name (empty = none). `context` is `"professional"` or `"personal"`; a favorite saved without one reads as `"professional"`, any other value is rejected (400). The task form shows only the favorites matching the repo's context.
- `GET /api/repos` → `Repo[]`, where `Repo` is `{id, name, path, jira_prefix, context, source, created_ms}`; `context` is `"professional" | "personal" | null`, and null reads as professional.
- `PATCH /api/repos/:id` `{name?, jira_prefix?, context?}` → `Repo` — other fields are ignored; a `context` other than the two values or `null` is a 400.
- `Reviewer` is `{name, command}` — a named review command. The command may contain `{base_branch}`, replaced with the task's base branch (or the repo's default) when a task is dispatched with that reviewer. Names are unique; both fields are required and trimmed.
- `PUT /api/config` `{jira?: {baseUrl, email, token, jql}, assistant?: string[], agents?: {...}, favorites?: Favorite[], reviewers?: Reviewer[], models?: {[modelId]: ModelFacts}}` → `{ok}`. A retention outside the four values, a non-numeric cost/index/minutes/score/monthly limit, or an `asOf` that is not `YYYY-MM-DD` is a 400.
- `GET /api/health` → `{ok: true}` (no auth)

- `GET /api/errors` → current background synchronization errors (`source`, `message`, `updated_ms`); cleared when the operation succeeds.

### Pull requests

- `GET /api/pulls` → `{pulls: Pull[], fetched_ms}` — the last listing, from memory or from the one saved at the previous shutdown (never waits on GitHub/GitLab).
- `POST /api/pulls/refresh` → the same shape, after querying both platforms. Single-flight: concurrent calls share one refresh. A platform that fails keeps its last listing (and reports itself in `GET /api/errors`); it never empties the page.
- `Pull` is `{id, host: "github"|"gitlab", number, title, url, repo, state: "open"|"draft", author, isMine, awaitingMe, color: "green"|"orange"|"red", reason, updated_ms}`.
- `awaitingMe` marks the human as the one awaited (a requested review, or their own PR); colleagues' PRs are listed with `awaitingMe: false` and sort after those.
- Discovery: review requests and the human's own open PRs/MRs on both platforms, plus the open PRs/MRs of colleagues in the repos Corral knows where the human can push (GitHub `permissions.push`, GitLab Developer and up) — 5 most recently updated per repo, 30 in total, push access re-probed every 6 h. Upstream projects the human merely cloned contribute nothing.
- `color`: `red` failing checks or changes requested, `orange` draft, checks running, unresolved threads, or no signals yet (a fresh PR is orange until automated reviews pass), `green` checks green and reviewed with nothing unresolved.

### POST /api/tasks/:id/artifact

Ask the active Claude session to create a private artifact and report its URL in the inbox. Returns 409 when the task has no active Claude session.

### GET /api/progression

Returns local progression: `xp`, `level`, `levelXp`, `nextLevelXp`, `tasks`, and `inbox`. Only eligible actions recorded after installation are counted.
