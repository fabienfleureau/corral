# AGENTS.md — working in the Corral repo

Corral is the **work layer** over **omnigent** (the agent layer): the inbox for
what needs a human — Jira intake, task dispatch, PR readiness, the review loop.
Server: Node 22 TypeScript, no runtime dependencies. UI: React + Vite + plain
CSS. Agents run through the `WorkerBackend` seam (`server/worker.ts`), today
backed by `server/omnigent.ts`.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and review,
[docs/architecture.md](docs/architecture.md) for system boundaries, and
[docs/adr/README.md](docs/adr/README.md) for accepted decisions.

## Workflow — every change ships as a PR

- **Never push directly to `main`.** Branch, commit, push the branch, open a PR
  (`gh pr create`). The human reviews and merges (squash).
- Branch names: `<type>/<short-slug>` — `feat/…`, `fix/…`, `docs/…`.
- Before pushing, all green: `npm test`, `npx tsc --noEmit -p
  tsconfig.server.json`, `npx tsc --noEmit -p web/tsconfig.json`, `npm run build`,
  and `npm run check:adr`.
- Keep PRs small and single-purpose. The description says **what changed, why,
  and how to test it** (including UI deep links like `#/pulls?color=red`).
- For UI changes, include labeled before-and-after screenshots of comparable
  views in the PR description. If screenshots cannot be captured or included,
  explain why.
- Say explicitly if your PR overlaps another open PR.
- Use the `pr-description` skill for PR titles and bodies. Keep its format;
  do not introduce a repository PR template that overrides it.

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
synthetic open, dispatched, and done tasks with pinned and default model settings,
plus a professional and a personal repo, favorites in both contexts, open
inbox items (a ready PR, a PR needing work, a question), a Jira-imported
task carrying its ticket link with an open question on it, so the inbox shows
ticket provenance, a dispatched task whose prompt quotes a local Markdown path,
and a Pull Requests listing (the human's own PR, a requested review,
colleagues' PRs and a draft MR). It seeds a defined KPI with a report and a
second defined KPI so the KPI page shows both columns. It also writes
synthetic Claude session logs so the Usage chart has data. It seeds dispatch and
stopped-run escalation metrics around the ADR 0016 pivot so the Improve page's
stopped-run table has rows.
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

Captures go through `scripts/screenshot-page.ts` (Chrome DevTools Protocol), which
waits for the page to settle instead of firing at load.

A state a navigation cannot produce — a text selection, an open panel — needs a
prepare expression, which runs before that wait:

```sh
CORRAL_FIXTURE_SETTLE="Boolean(document.querySelector('.selection-task'))" \
CORRAL_FIXTURE_PREPARE="$(cat select-first-paragraph.js)" \
  scripts/capture-screenshot.sh "$PWD" "$shot_dir/after.png" /inbox
```

The prepare expression is evaluated in the page; an async IIFE can poll for
fixture data that renders after mount. Capture the same route and viewport in
the base checkout (no prepare) for the before image. If the view needs the
harness list, point `CORRAL_FIXTURE_OMNIGENT_URL` at a local stub that answers
`/v1/agents` and `/v1/hosts`; the fixture keeps GitHub and other services stubbed.
Use the same stub for both checkouts.

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

### README demo GIF

`docs/demo.gif` is the one committed capture. `scripts/record-demo.ts` records
it from the same fixture: a scripted tour (inbox, task history, plan diff, PRs,
new task, epics, pull requests, KPI) with a drawn pointer and captions, encoded
by `ffmpeg`.
A `.gif` output switches the capture script to that tour:

```sh
npm run build
mv docs/demo.gif "$shot_dir/old-demo.gif"   # the script refuses to overwrite
scripts/capture-screenshot.sh "$PWD" "$PWD/docs/demo.gif"
```

Regenerate it when a toured page changes visibly. The tour only selects,
types and filters; keep it that way (no dispatch, answer, summarize or Jira
import). On failure the last frame is saved next to the output as
`.failed.png`.

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
  keep it short and imperative. Every prompt Corral sends (these conventions,
  the PR-loop messages, the assistant calls) is registered in
  `docs/prompts.md`; add the row in the same PR as the prompt, or
  `server/test/prompts-doc.test.ts` fails.
- Web UI work (`web/`) uses the `modern-web-guidance` skill, installed in
  `.agents/skills/` (Codex, OpenCode) and linked from `.claude/skills/` for
  Claude Code. Baseline target: Baseline Widely available. Refresh with
  `npx skills update`. The `emil-design-eng`, `break-ui` and `review-animations`
  skills come from `emilkowalski/skills` and are installed the same way: use
  `emil-design-eng` for interaction polish, `break-ui` with the fixture below
  for realistic worst-case data, and `review-animations` when reviewing the CSS
  motion in `web/src/styles.css`. They are invoked by the human or their agent,
  never injected by Corral. Repo rules win: no new runtime dependencies, and
  screenshots still come from the fixture in this file.

## Decision records and documentation

- Every PR must reference applicable ADRs or explain specifically why none is
  needed. Add an ADR in the same PR for a consequential architectural, product
  boundary or lasting technology decision; follow [the policy](docs/adr/README.md).
- Preserve ADR filenames and reasoning. Supersede an accepted decision with a new
  record and links; never silently rewrite it or invent historical alternatives.
- Update [docs/architecture.md](docs/architecture.md) when boundaries or flows
  change, and the README/product guide when user workflows change.
- CI validates ADR structure and index links. Human review judges whether the
  change needs a record and whether its trade-offs are explained.

## Layout

| | |
|---|---|
| `server/` | API (`api.ts`), worker seam (`worker.ts`, `omnigent.ts`), PR loop (`pr.ts`), inbox lifecycle (`capture.ts`), dispatch (`dispatch.ts`), task history (`task-events.ts`) |
| `web/` | React UI, hash-routed pages (`#/inbox`, `#/tasks`, `#/pulls`, `#/sessions`, `#/improve`, `#/settings`); the task history modal is `TaskHistory.tsx` |
| `skills/` | Prompt conventions for dispatched agents (question reports, PR loop, handoff) |
| `docs/architecture.md` | Source-linked system diagram, responsibilities, flows and limits |
| `docs/adr/` | Decision records, index, policy and template |
| `docs/product-guide.md` | Feature, configuration and CLI reference |
| `docs/prompts.md` | Registry of every prompt Corral sends — the place to look first |
| `API.md` | HTTP contract — keep in sync with `server/api.ts` |

## Product decisions are binding

Settled design (don't silently relitigate in code): Corral = work layer,
omnigent = agent layer (deep-link out to inspect agents); PR readiness gate =
answered/resolved threads + green checks + mergeable; a **fresh PR is orange**
until automated reviews pass; merged PRs complete their task and archive its items; confs =
harness + optional pins (blank = smart-route), agents are an explicit opt-in.
Ask before changing product semantics.
