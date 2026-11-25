# 0023 — Approving a multi-repo plan creates and dispatches child tasks directly

Status: Proposed

## Context

Previously, `POST /api/tasks/:id/approve-plan` (and the **Approve plan** button
in the inbox) created one `open` `code` task per sub-task on the Tasks page,
requiring the human to switch to `#/tasks` and manually dispatch every child
task one by one. Because a multi-repo plan has already been reviewed and
approved in the inbox, leaving its children unstarted adds friction without an
extra safety check.

## Decision

Approving a multi-repo `spec` plan now creates **and immediately dispatches**
all child `code` tasks sequentially from `approvePlan()` (`server/multi-repo.ts`),
inheriting `target`, `agent`, `model`, and `reasoning` (alongside `assignee`,
`jira_parent_key`, and `parent_task_id`) from the parent `spec` task:

- Upfront validation, child task insertion, marking the `spec` task `done`, and
  resolving its `plan` inbox item all commit synchronously **before** any async
  dispatch begins, preserving strict once-only approval idempotency (`400` on
  retry) and ensuring `contractBlock()` reads the saved spec.
- Children are dispatched sequentially via an injected callback from
  `server/api.ts` (avoiding a circular import between `server/multi-repo.ts`
  and `server/dispatch.ts`).
- Partial dispatch failures (or a parent `spec` with no `target`) do not fail
  the HTTP approval or roll back earlier dispatched siblings. Each failed child
  remains `status: "open"` on the Tasks page for manual retry, logs a `session`
  event, and is returned in `dispatch_errors: [{task_id, title, error}]`
  alongside the freshly read `children` list.

## Alternatives considered

- **Keep manual dispatch on the Tasks page:** Preserves a separate launch step
  before agents start, at the cost of forcing the reviewer to open `#/tasks` and
  click Dispatch on every sub-repo after already clicking Approve plan.
- **Roll back or fail the entire approval when one child dispatch fails:**
  Would leave already-started agent sessions orphaned or force re-approving the
  whole plan when a single sub-repo fails to dispatch.
- **Dispatch from the browser client after `approve-plan` returns:** Splits an
  atomic server workflow across N client HTTP calls, breaks API-only callers, and
  risks partial execution if the tab closes mid-loop.

## Consequences

- `POST /api/tasks/:id/approve-plan` is now `async` and returns
  `{ children, dispatch_errors }` instead of `{ children }`.
- Inbox displays a dismissible notice (status or warning with a link to
  `#/tasks`) after plan approval so the outcome remains visible even when the
  approved plan was the last open inbox item.
- `skills/spec.md`, `API.md`, `docs/prompts.md`, and `docs/product-guide.md` are
  updated to describe direct dispatch on approval.
