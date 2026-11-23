# Observe-only risk triage for PR inbox items

Status: Proposed

## Context

Every green PR in the Corral inbox currently looks identical ("ready for review"),
whether it is a 20-line documentation tweak or a 400-line database migration.
Meanwhile, Corral's settled product boundary is that the human always owns PR
approval and merging — Corral must not auto-approve or auto-merge pull requests.

## Decision

Add a deterministic, strictly **observe-only** risk triage classifier
(`server/pr-triage.ts`) that labels open PR items as either `routine` (quick
skim) or `deep` (deep review required), with a suggested review depth (`quick`,
`standard`, `deep`) and concise human-readable reasons.

- A repository can check in `.corral/triage.json` (`deepPaths`, `routinePaths`,
  `maxRoutineLines`, `maxRoutineFiles`) merged over built-in defaults.
- Triage is persisted on the PR inbox item (`items.triage`) and in the PR
  snapshot (`tasks.pr_meta`), and rendered as an informational badge and table
  row in the inbox.
- Triage never alters `prReady()`, `prReviewLabel()`, Jira lifecycle stages, or
  merge eligibility.

## Alternatives and trade-offs

- **Auto-approve routine PRs** (as in Claude Approvals): rejected because it
  violates Corral's human-owned approval boundary and turns a local personal
  work layer into a policy enforcement engine.
- **LLM-classified triage on every PR sync**: rejected for now to avoid latency,
  token cost, and non-determinism during periodic 2-minute PR polling; path
  globs and diff thresholds are instant, zero-cost, and inspectable, and can be
  extended later if needed.
