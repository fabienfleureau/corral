# Contributing

Corral coordinates work; omnigent runs agents. Keep that ownership boundary and
existing product decisions intact. Start with the [architecture](docs/architecture.md)
and the [decision index](docs/adr/README.md) before changing a workflow.

## Local setup

Use Node.js 22.18 or newer. CI uses Node 22. Install the locked dependencies:

```sh
npm ci
npm run build
```

For interactive development, run `npm run serve` and `npm run dev:web` in
separate terminals. The API listens on `127.0.0.1:4787`; Vite listens on
`localhost:5173` and proxies `/api`. Use the printed access URL to authenticate;
see the [product guide](docs/product-guide.md) for configuration and CLI usage.
Dispatch needs a running omnigent backend. PR/Jira features need their configured
accounts. Unit tests use fakes and temporary databases instead of these services.

Restart the server after server code or config file edits. A new web build is
served on the next request; hard-reload once after significant service worker
changes. Never put access tokens, session data or local configuration in a PR.

## Make a focused change

Work on a branch named `<type>/<short-slug>`, such as `fix/pr-refresh` or
`docs/architecture`. Never push directly to `main`. Use conventional commits:
`type(scope): description`, without attribution trailers.

Keep these constraints:

- Node executes erasable TypeScript directly: no enums or parameter properties.
- No new runtime dependencies without discussion. The server uses Node built-ins;
  the web runtime uses React and React DOM.
- Use `WorkerBackend` for agents and the existing platform integration modules
  for git, Jira, and PRs. Do not scatter provider-specific calls across the UI.
- Keep SQLite migrations additive in `Db.migrate()` and preserve existing data.
- Test changed behavior at its boundary, including failure cases that matter.
  Prose edits do not need artificial tests that merely repeat the documentation.

## Record decisions and keep contracts current

Every PR must cite the applicable ADR(s) or explain specifically why none is
needed. A consequential choice about ownership, product semantics, architecture
or lasting technology coupling needs an ADR in the same PR. Routine fixes do
not require a new record. Follow the [ADR policy and template](docs/adr/README.md),
including supersession links when replacing an accepted decision.

Update the [architecture guide](docs/architecture.md) when responsibilities or
flows change; update [API.md](API.md) with HTTP contract changes. Every agent
prompt must be registered in [docs/prompts.md](docs/prompts.md) in the same PR.
Update the README or product guide when user-visible workflows change.

Reviewers check whether the decision was recorded and whether its trade-offs
are clear. `check:adr` checks structural consistency, not that judgment.

## Verify before pushing

```sh
npm test
npx tsc --noEmit -p tsconfig.server.json
npx tsc --noEmit -p web/tsconfig.json
npm run build
npm run check:adr
git diff --check
```

`npm run typecheck` runs both TypeScript checks. GitHub Actions runs tests, both
type checks, build and ADR validation on PRs and pushes to `main`. Required status
checks and branch protection must be configured separately by a repository
administrator; a workflow file alone does not prevent merging.

## Open a reviewable PR

Explain the problem and resulting behavior, the decision/documentation impact,
verified checks and gaps, risk, rollback, and manual acceptance steps. Use the
`pr-description` skill for the title and body format, including the ADR reference
or no-ADR explanation within that format. Mention overlapping open PRs. Keep the
title and description current after each push.

For visible UI changes, use the isolated fixture and comparable before/after
captures described in [AGENTS.md](AGENTS.md#repeatable-ui-screenshots). Inspect
both images and include labeled links in the PR; explain specific capture/upload
failures if needed. Do not use the live app or commit generated screenshots.
Regenerate the README demo only when a toured page visibly changes.

The human reviews and merges, using squash. Address review comments and rerun
the checks affected by a fix before pushing. Agent-specific dispatch and capture
instructions remain in [AGENTS.md](AGENTS.md).
