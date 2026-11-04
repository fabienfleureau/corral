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

## Repeatable UI screenshots

Use the fixture in this checkout, never the live app. It starts a server with a
fresh temporary home, config, database, and browser profile; GitHub refresh is
disabled and the agent backend points to an unavailable local address. It seeds
synthetic open, dispatched, and done tasks with pinned and default model settings.
The script cleans up its server and temporary data on exit. Do not dispatch tasks
or connect the fixture to real services.

Capture the same route and viewport from the base and the current checkout:

```sh
shot_dir=$(mktemp -d "${TMPDIR:-/tmp}/corral-shots.XXXXXX")
mkdir "$shot_dir/base"
git archive origin/main | tar -x -C "$shot_dir/base"
(cd "$shot_dir/base" && npm ci && npm run build)
npm ci && npm run build
scripts/capture-screenshot.sh "$shot_dir/base" "$shot_dir/before.png" /tasks
scripts/capture-screenshot.sh "$PWD" "$shot_dir/after.png" /tasks
```

Replace `origin/main` with the PR base and `/tasks` with the same hash route for
both captures. Set `CHROME` to the Chrome/Chromium executable if it is not at
its default macOS location. The capture uses 1440×1000 pixels, a fresh profile,
and a local random port. If Chrome fails in the sandbox, use the supported
outside-sandbox permission. Inspect both PNGs with an image viewer before
uploading; confirm the intended route, fixture data, and comparable framing.
For a different UI state, use an isolated browser with the same fixture and
viewport for both captures; do not use the live app.

Attach with `gh pr create` or `gh pr edit` using
`--attach "$shot_dir/before.png#Before" --attach "$shot_dir/after.png#After"`
(gh 2.99+). Run `gh pr view <number> --json body --jq .body` and confirm the
saved description contains both labeled image links. If capture or upload fails,
record the specific failure in the PR. Delete the temporary directory when done;
never commit screenshots or generated fixture data.

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
