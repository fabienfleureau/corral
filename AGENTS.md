# AGENTS.md — working in the Corral repo

Corral is the **work layer** over **omnigent** (the agent layer): the inbox for
what needs a human — Jira intake, task dispatch, PR readiness, the review loop.
Server: Node 22 TypeScript, no runtime dependencies. UI: React + Vite + plain
CSS. Agents run through the `WorkerBackend` seam (`server/worker.ts`), today
backed by `server/omnigent.ts`.

## Workflow — every change ships as a PR

- **Never push directly to `main`.** Branch, commit, push the branch, open a PR
  (`gh pr create`). The human reviews and merges (squash).
- Branch names: `<type>/<short-slug>` — `feat/…`, `fix/…`, `docs/…`.
- Before pushing, all green: `npm test`, `npx tsc --noEmit -p
  tsconfig.server.json`, `npx tsc --noEmit -p web/tsconfig.json`, `npm run build`.
- Keep PRs small and single-purpose. The description says **what changed, why,
  and how to test it** (including UI deep links like `#/pulls?color=red`).
- For UI changes, include labeled before-and-after screenshots of comparable
  views in the PR description. If screenshots cannot be captured or included,
  explain why.
- Say explicitly if your PR overlaps another open PR.

## Dev loop

- `npm run serve` — server on <http://127.0.0.1:4787> (access token in
  `~/.config/corral/config.json`).
- `npm run build` — rebuilds `web/dist`; the server serves it per request, so a
  browser refresh is enough for UI changes (service worker caches: hard-reload
  once after big UI changes).
- **Server** code changes need a server restart. Config file changes too.
- Tests: `npm test` (node --test over `server/test/`).

## Code conventions

- TypeScript: **erasable syntax only** (no enums, no parameter properties) —
  Node executes it type-stripped.
- No new runtime dependencies without discussion; the server is node built-ins
  only (web may use react/react-dom only).
- Platform access goes through seams: `server/worker.ts` (agents),
  `server/pulls.ts` (GitHub/GitLab PRs), `server/jira.ts` (Jira),
  `server/repos.ts` (git repos). Keep backends swappable.
- Storage is SQLite (`server/db.ts`); schema changes are **additive** with
  `ALTER TABLE` migrations in `Db.migrate()`.
- Agent-facing prompt text lives in `skills/` and is injected at dispatch —
  keep it short and imperative.

## Layout

| | |
|---|---|
| `server/` | API (`api.ts`), worker seam (`worker.ts`, `omnigent.ts`), PR loop (`pr.ts`), inbox lifecycle (`capture.ts`), dispatch (`dispatch.ts`) |
| `web/` | React UI, hash-routed pages (`#/inbox`, `#/tasks`, `#/pulls`, `#/sessions`, `#/ideas`, `#/settings`) |
| `skills/` | Prompt conventions for dispatched agents (question reports, PR loop, handoff) |
| `API.md` | HTTP contract — keep in sync with `server/api.ts` |

## Product decisions are binding

Settled design (don't silently relitigate in code): Corral = work layer,
omnigent = agent layer (deep-link out to inspect agents); PR readiness gate =
answered/resolved threads + green checks + mergeable; a **fresh PR is orange**
until automated reviews pass; merged PRs complete their task and archive its items; confs =
harness + optional pins (blank = smart-route), agents are an explicit opt-in.
Ask before changing product semantics.
