# Corral

The work layer over omnigent agents — Claude Code, Codex,
OpenCode. Feed it tasks, then answer what needs you from one mail-style inbox.
No conversation details in the app: **summary + link out** to the omnigent session.

```
idea → Jira (clarify outside Corral) → task backlog → dispatch (worktree + agent)
     → agent asks a question / opens a PR → inbox item → you answer or review
     → item auto-resolves; a merged PR completes the task
```

Corral owns the *work* (intake, dispatch, PR readiness, the review loop).
omnigent owns the *agents* (sessions, worktrees, models). Agents run through the
`WorkerBackend` seam (`server/worker.ts`), today backed by `server/omnigent.ts`.

## What it does

- **Task backlog** — create tasks in the web UI or `corral add`, or import from
  **Jira** (one-way pull via JQL filter + manual search, deduped by issue key).
  Jira subtasks group under their parent; when all children resolve, the parent's
  **Mark done** CTA lights up. A task imported from Jira also drives its ticket's
  **status**, forward only: dispatch → `In Progress`, PR/MR opened → `Code Review`,
  PR shown by Corral as `ready to merge` (gate passed **and** a human approved it)
  → `Ready to merge`, merged → `Done` (names configurable per workflow).
- **Dispatch** — one click. Pick a harness (Claude/Codex/OpenCode) and optionally
  pin an agent, model and reasoning level; blank means omnigent smart-routes.
  Each task gets a fresh git worktree created by omnigent (opt out per task).
  **Favorites** save a harness/model/reasoning combination, scoped to a
  professional or personal repo context. An optional **pre-PR review step** runs
  a named reviewer command (`reviewers` in the config) before the PR opens.
- **Prompt attachments** — drop files on the New task prompt, paste a screenshot
  or pick them: PNG, JPEG, GIF and WebP images, PDFs, and text or code files (up
  to 10 files, 25 MB). They are stored with the task and sent to the agent with
  the first prompt, as session files omnigent hands to the harness.
- **Review tasks** — a task of kind `review` points at someone else's PR/MR. The
  agent drafts its review, and publishes only after you approve it in the inbox.
- **Question inbox** — dispatched agents are given `skills/question-report.md`,
  which tells them to POST a clean question via `$CORRAL_URL/api/reports`. Structured
  question batches and permission requests are answered from the item. Snooze
  (1h, 4h, tomorrow) and archive sit on top.
- **PR loop** — Corral watches each task's PR/MR. Review comments and merge
  conflicts are pushed back to the agent (`skills/pr-loop.md`). The item turns
  **green** only when threads are answered or resolved, checks pass and the PR
  is mergeable; a fresh PR is **orange** until automated reviews pass. **Force
  refresh** re-checks one PR on demand. A merged PR completes its task and
  archives its items (see the **Archived** tab).
- **Pull Requests page** — your own PRs/MRs, review requests, and colleagues' open
  PRs in repos where you can push, on GitHub and GitLab, grouped by repo and
  colored by readiness.
- **Select → new task** — select a passage anywhere (an inbox report, typically)
  and a *New task* action hands it to the Tasks page as the prefilled prompt.
- **Task history** — every task carries an append-only log of what happened to it:
  creation, edits, state changes, each prompt sent to the agent, Jira status
  moves, PR milestones and agent questions. Open it from the inbox or the tasks
  list (`GET /api/tasks/:id/events`).
- **Sessions** — the omnigent sessions Corral knows about, with a link out to each.
- **Usage** — Claude Code, Codex and OpenCode Go spend and quota from local
  session data, cost per done task, PR additions, and GitHub/GitLab API rate
  limits for the PR loop.
- **Model facts** — a shipped catalog of model facts (retention, quota, cost,
  benchmark scores) shows indicators on the task form.
- **Improvement analysis** — on demand or on a schedule, the configured assistant
  reviews recent task and PR activity and posts a digest to the inbox. It never
  dispatches work.
- **Notifications** — in-app + desktop, for new actionable items only.
- **Metrics** — every event (created/dispatched/replied/resolved/…) is recorded
  (`/api/metrics/summary`).
- **Offline mode** — a service worker caches the app shell and the last-known API
  responses, so the inbox opens on a flaky connection showing cached data. An
  offline banner shows when you are disconnected.

Pages are hash-routed: `#/inbox`, `#/tasks`, `#/pulls`, `#/sessions`, `#/usage`,
`#/settings`, `#/errors`.

## Quickstart

Requires Node ≥ 22.18, a running omnigent server, and `gh` / `glab` for the PR
features.

```sh
npm install
npm run build            # web/dist, served by the server
npm run serve            # http://127.0.0.1:4787 — first run prints your access URL
```

Open the printed `http://127.0.0.1:4787/?token=…` once (it sets the cookie).

Dev mode (API + Vite with hot reload):

```sh
npm run serve            # terminal 1
npm run dev:web          # terminal 2 → http://localhost:5173
```

Server code changes need a server restart; `npm run build` is enough for UI
changes.

CLI (talks to the running server):

```sh
corral add "Fix flaky upload test" --repo ~/work/api --prompt "…" --target claude
corral status
```

## Prompts

Corral tells each agent what to do through short prompt conventions. **Every
prompt it sends — the injected `skills/*.md` conventions, the PR-loop messages,
and Corral's own assistant calls — is listed in [`docs/prompts.md`](docs/prompts.md)**:
what it says, when it is sent, and which placeholders get substituted. Start
there before changing agent behaviour.

## Configuration

`~/.config/corral/config.json` (generated on first run). The Settings page edits
the common keys; the file wins on restart.

| Key | Default | |
|---|---|---|
| `port` / `host` | `4787` / `127.0.0.1` | localhost; token middleware ready for LAN/team |
| `token` | generated | shared by web cookie + CLI + agent reports |
| `omnigent` | `{baseUrl: http://127.0.0.1:6767, token, hostId, agents, localProviders}` | the agent backend; `agents` maps a harness id to an omnigent registration/harness, `localProviders` lists local model servers to probe |
| `agents` | `claude`, `codex`, `opencode` | harnesses offered in the UI |
| `assistant` | `["claude","-p","{prompt}"]` | Corral's own LLM calls (summaries, improvement analysis) |
| `jira` | `{baseUrl, email, token, jql, statuses?}` | email + API token (Basic); `statuses` maps stage → Jira status name (`to_do`, `in_progress`, `code_review`, `ready_to_merge`, `done`), blank disables a stage |
| `favorites` | `[]` | saved harness/agent/model/reasoning combos, with a context and an optional reviewer |
| `reviewers` | `cubic`, `ocr` | named pre-PR review commands; `{base_branch}` is substituted |
| `models` | `{}` | overrides merged over the shipped model facts catalog |
| `usage.prices` | `{}` | price overrides (USD/MTok) by model id or `prefix*` |
| `workspaceRoots` | `~/workspace` | directories scanned for git repos |
| `worktreesDir` | `~/.herdr/worktrees` | legacy; omnigent now creates worktrees |

Env overrides: `CORRAL_PORT`, `CORRAL_HOST`, `CORRAL_TOKEN`, `CORRAL_DATA_DIR`.

## Architecture

```
web/          React UI (pages above) — vite build → web/dist
server/       Node 22 (type-stripped TS), no runtime deps
  index.ts    wiring: config → db → worker backend → HTTP
  api.ts      REST + SSE + token auth + static hosting
  worker.ts   the WorkerBackend seam; omnigent.ts is the implementation
  capture.ts  agent events → inbox items → auto-resolution
  dispatch.ts prompt assembly and session start
  attachments.ts  files attached to a prompt: allowed types, size caps
  pr.ts       PR loop: readiness gate, comments, conflicts, merge
  pulls.ts    GitHub/GitLab PR listing; repos.ts is the repo seam
  jira.ts     REST v3 (search, transitions, ADF comments)
  jira-status.ts  task lifecycle → Jira status (forward-only)
  task-events.ts  per-task history
  usage.ts    local session scan, cost and quota
  improvement*.ts  digest evidence and scheduled analysis
  db.ts       SQLite (tasks, items, task events, metrics)
  cli.ts      corral add / status / serve
skills/       agent prompt conventions, injected at dispatch
docs/         prompts.md — the registry of every prompt Corral sends
scripts/      repeatable UI screenshot fixture (see AGENTS.md)
API.md        the HTTP contract
```

Storage: `~/.local/share/corral/corral.db` (SQLite, additive migrations). The
data model carries `assignee` and `machine` fields for the planned team product
and remote workers.

## Roadmap

- **next** — daily digest, routing suggestions (quota headroom + editable rules)
- **later** — auto-dispatch queue, agent-fed intake, remote machines, fuller
  Jira sync (comments back)

## Contributing

Every change ships as a PR; see [`AGENTS.md`](AGENTS.md) for the workflow, code
conventions and how to capture before/after UI screenshots.

## Tests

```sh
npm test          # node --test over server/test/
npm run typecheck # server + web
npm run build
```
