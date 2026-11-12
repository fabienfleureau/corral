# Corral

Feed work to your [herdr-core](https://herdr.dev/core/) workers — Claude Code, Codex,
OpenCode — and answer what needs you from one mail-style inbox. No conversation
details in the app: **summary + link out**.

```
idea → Jira (clarify outside Corral) → task backlog → dispatch (worktree + agent)
     → agent asks a question / finishes → inbox item → you answer from the item
     → item auto-resolves
```

## What it does (v1)

- **Task backlog** — create tasks in the web UI or `corral add`, or import from
  **Jira** (one-way pull via JQL filter + manual search, deduped by issue key).
  Jira subtasks group under their parent; when all children resolve, the parent's
  **Mark done** CTA lights up (manual write CTAs only: mark done, add comment).
  A task imported from Jira also drives its ticket's **status**, forward only:
  dispatch → `In Progress`, PR/MR opened → `Code Review`, PR shown by Corral as
  `ready to merge` (gate passed **and** a human approved it) → `Ready to merge`,
  merged → `Done` (names configurable per workflow).
- **Dispatch** — one click, with a suggested target (Claude/Codex/OpenCode).
  Each task gets a fresh **git worktree** (`~/.herdr/worktrees/<repo>/<branch>`)
  and an agent terminal managed by herdr-core. Opt out per task.
- **Question inbox** — two capture paths:
  1. **Structured reports**: dispatched agents are given `skills/question-report.md`,
     which tells them to POST a clean question via `$CORRAL_URL/api/reports`.
  2. **Blocked fallback**: when an agent terminal reports `blocked` (OSC 7501),
     Corral captures a raw output tail — with an on-demand **Summarize** button
     (your configured assistant model, headless).
- **Answer from the inbox** — reply box sends the answer straight into the agent's
  terminal (`hc send`), plus an "open in terminal" escape hatch.
- **Select → new task** — select a passage anywhere (an inbox report, typically)
  and a *New task* action hands it to the Tasks page as the prefilled prompt.
- **Task history** — every task carries an append-only log of what happened to
  it: creation, edits, state changes, each prompt sent to the agent (dispatch,
  your replies, PR-loop hand-offs), Jira status moves, PR milestones and agent
  questions. Open it from the inbox or the tasks list (`GET
  /api/tasks/:id/events`); it answers "how did this task get here?" without
  reading a transcript.
- **Auto-resolving lifecycle** — questions close when the agent leaves `blocked`;
  a merged PR completes its task and archives every inbox item tied to it (see the
  **Archived** tab);
  tasks close when the agent exits. Manual snooze + archive on top.
- **Notifications** — in-app + desktop, for new actionable items only.
- **Metrics** — every event (created/dispatched/replied/resolved/…) is recorded
  from day one (`/api/metrics/summary`), feeding the future daily analysis.
- **Offline mode** — a service worker caches the app shell and the last-known
  API responses: the inbox opens on a flaky connection showing cached data
  (network-first; a real network failure falls back to the cache, a slow
  endpoint is simply awaited), static assets are cache-first, streams and
  mutations pass through. An offline banner shows when
  you are disconnected.

## Quickstart

```sh
npm install
npm run serve            # http://127.0.0.1:4787 — first run prints your access URL
```

Open the printed `http://127.0.0.1:4787/?token=…` once (it sets the cookie).

Dev mode (API + Vite with hot reload):

```sh
npm run serve            # terminal 1
npm run dev:web          # terminal 2 → http://localhost:5173
```

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

`~/.config/corral/config.json` (generated on first run):

| Key | Default | |
|---|---|---|
| `port` / `host` | `4787` / `127.0.0.1` | localhost; token middleware ready for LAN/team |
| `token` | generated | shared by web cookie + CLI + agent reports |
| `herdrSocket` | `~/.local/state/herdr-core/default/default.sock` | herdr-core JSON-RPC socket |
| `agents` | `claude`, `codex`, `opencode` | harnesses offered in the UI; sessions launch through omnigent's registry harness |
| `assistant` | `["claude","-p","{prompt}"]` | Corral's own LLM calls (summarization) |
| `jira` | `{baseUrl, email, token, jql, statuses?}` | email + API token (Basic); `statuses` maps stage → Jira status name (`to_do`, `in_progress`, `code_review`, `ready_to_merge`, `done`), blank disables a stage |
| `worktreesDir` | `~/.herdr/worktrees` | per-task worktrees |

## Architecture

```
web/          React UI (inbox, tasks, settings) — vite build → web/dist
server/       Node 22 (type-stripped TS), no runtime deps
  index.ts    wiring: config → db → herdr streams → HTTP
  api.ts      REST + SSE + token auth + static hosting
  herdr.ts    JSON-RPC client over herdr-core's Unix socket + `hc events` stream
  capture.ts  events → inbox items → auto-resolution (+ 30s reconcile)
  dispatch.ts worktree creation, prompt assembly, terminal.run
  jira.ts     REST v3 (search, transitions, ADF comments)
  jira-status.ts  task lifecycle → Jira status (forward-only, walks missing stages)
  db.ts       SQLite (tasks, items, terminals, metrics_events)
  cli.ts      corral add / status / serve
skills/       agent prompt conventions, injected at dispatch (see docs/prompts.md)
docs/         prompts.md — the registry of every prompt Corral sends
```

Storage: `~/.local/share/corral/corral.db` (SQLite). The data model carries
`assignee` and `machine` fields for the planned team product and remote workers.

## Roadmap (agreed design)

- **v2** — PR/MR watchlist (readiness = CI green + threads resolved + mergeable;
  watched-repo polling via `gh`/`glab`), daily digest
- **v3** — daily self-improvement analysis (propose + prepare, human approves
  everything), subscription usage page (live quota windows + history charts),
  routing suggestions (quota headroom + editable rules)
- **later** — auto-dispatch queue, agent-fed intake, remote machines, fuller
  Jira sync (pull status back, comments back)

## Tests

```sh
npm test          # unit: slugify, db, worktrees, capture lifecycle
npm run typecheck # server + web
```
