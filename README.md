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
- **Auto-resolving lifecycle** — questions close when the agent leaves `blocked`;
  a merged PR completes its task and archives every inbox item tied to it (see the
  **Archived** tab);
  tasks close when the agent exits. Manual snooze + archive on top.
- **Notifications** — in-app + desktop, for new actionable items only.
- **Ideas** — free-form capture (`corral idea`) into a tagged list
  (workflow/product), the seed of the planned daily self-improvement loop.
- **Metrics** — every event (created/dispatched/replied/resolved/…) is recorded
  from day one (`/api/metrics/summary`), feeding the future daily analysis.
- **Offline mode** — a service worker caches the app shell and the last-known
  API responses: the inbox opens on a flaky connection showing cached data
  (network-first with a 3s timeout; stale beats nothing), static assets are
  cache-first, streams and mutations pass through. An offline banner shows when
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
corral idea "snooze-until-green for PR items" --tag product
corral status
```

## Configuration

`~/.config/corral/config.json` (generated on first run):

| Key | Default | |
|---|---|---|
| `port` / `host` | `4787` / `127.0.0.1` | localhost; token middleware ready for LAN/team |
| `token` | generated | shared by web cookie + CLI + agent reports |
| `herdrSocket` | `~/.local/state/herdr-core/default/default.sock` | herdr-core JSON-RPC socket |
| `agents` | `claude`, `codex`, `opencode` | launch argv per target, `{prompt}` placeholder |
| `assistant` | `["claude","-p","{prompt}"]` | Corral's own LLM calls (summarization) |
| `jira` | `{baseUrl, email, token, jql}` | email + API token (Basic) |
| `worktreesDir` | `~/.herdr/worktrees` | per-task worktrees |

## Architecture

```
web/          React UI (inbox, tasks, ideas, settings) — vite build → web/dist
server/       Node 22 (type-stripped TS), no runtime deps
  index.ts    wiring: config → db → herdr streams → HTTP
  api.ts      REST + SSE + token auth + static hosting
  herdr.ts    JSON-RPC client over herdr-core's Unix socket + `hc events` stream
  capture.ts  events → inbox items → auto-resolution (+ 30s reconcile)
  dispatch.ts worktree creation, prompt assembly, terminal.run
  jira.ts     REST v3 (search, transitions, ADF comments)
  db.ts       SQLite (tasks, items, ideas, terminals, metrics_events)
  cli.ts      corral add / idea / status / serve
skills/       question-report.md (injected into agent prompts), clarify.md
```

Storage: `~/.local/share/corral/corral.db` (SQLite). The data model carries
`assignee` and `machine` fields for the planned team product and remote workers.

## Roadmap (agreed design)

- **v2** — PR/MR watchlist (readiness = CI green + threads resolved + mergeable;
  watched-repo polling via `gh`/`glab`), Ideas page + daily digest
- **v3** — daily self-improvement analysis (propose + prepare, human approves
  everything), subscription usage page (live quota windows + history charts),
  routing suggestions (quota headroom + editable rules)
- **later** — auto-dispatch queue, Jira two-way sync, agent-fed intake, remote machines

## Tests

```sh
npm test          # unit: slugify, db, worktrees, capture lifecycle
npm run typecheck # server + web
```
