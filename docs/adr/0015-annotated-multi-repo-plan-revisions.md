# 0015 — Annotated revisions and revision-pinned approval for multi-repo plans

Status: Proposed

Multi-repo `spec` tasks previously overwrote `tasks.spec` on each plan report,
refreshed the open inbox item in place with no history, and approved whatever
spec happened to be stored for the task ID. Reviewers could neither attach
quoted comments to a specific plan revision nor guard against approving a plan
that changed while they were reading it.

Corral will store immutable plan revisions in a `plan_revisions` SQLite table
(and submitted feedback rounds in `plan_reviews`) while keeping `tasks.spec`
synced to the latest revision plus its `revision_id` for backwards compatibility
with `contractBlock()`. Both `POST /api/tasks/:id/approve-plan` and the new
`POST /api/tasks/:id/request-plan-changes` require `revision_id` and reject
stale requests with `409 Conflict`. Requesting changes sets `handling = 1` on
the single plan inbox item so it moves to **In progress** (matching PR items)
and returns to **Open** when the next revision arrives through
`POST /api/reports`. Unpublished comment drafts live client-side in
`localStorage` keyed by `(task_id, revision_id)` and are persisted to SQLite
only when submitted. Revision feedback travels through `WorkerBackend.send`; if
the spec session is gone, the request fails without mutating item state or
clearing the draft.

Alternatives considered:
- Store revision history inside the `tasks.spec` JSON column: avoids new tables
  but bloats the task row and complicates indexed lookup and review history.
- Persist unpublished drafts in SQLite and sync across tabs: shares drafts
  across devices but requires draft CRUD endpoints and conflicts with isolating
  a stale tab's v1 draft from another tab viewing v2.
- Resolve the plan item on Request changes and open a new item for v2: loses
  the single-item-per-plan model and risks duplicate items or accidental
  resolution through the generic reply box.
- Auto-spawn a fresh agent session when `WorkerBackend.send` fails: hides
  session loss behind an unexpected re-dispatch; keeping v1 on `send` matches
  omnigent's idle-session model and can be extended later.

Consequences:
- Child `code` task creation remains tied strictly to approving the current
  revision, preventing stale approvals across tabs or mid-review updates.
- Plan diffing uses a small dependency-free line-and-word Markdown diff in the
  web client, preserving Corral's zero-new-runtime-dependencies rule.
- `skills/spec.md` must instruct spec agents to stay idle after reporting a
  plan so revision feedback can be delivered over `WorkerBackend.send`.

Design spec: [2026-11-21-annotated-multi-repo-plan-revisions-design.md](../superpowers/specs/2026-11-21-annotated-multi-repo-plan-revisions-design.md).
