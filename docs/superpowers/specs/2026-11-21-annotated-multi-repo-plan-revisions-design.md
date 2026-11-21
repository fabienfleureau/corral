# Annotated revisions for multi-repo plans

Status: approved by the human on 2026-11-21. Scope: annotated feedback, revision history, Markdown diffing, and revision-pinned approval for multi-repo `spec` plans.

## Intent

Corral's multi-repo `spec` flow already renders a proposed contract and per-repo sub-tasks in the inbox and creates child `code` tasks on approval (`server/multi-repo.ts`, `server/capture.ts`, `web/src/pages/Inbox.tsx`). Today, however, a reviewer cannot annotate specific clauses in place, send a structured revision request, compare what changed between versions, or be sure they are approving the exact revision they just read.

Borrowing the plan-review loop from Plannotator, this design adds inline plan annotations, a single batched **Request changes** round through the existing `WorkerBackend` seam, a dependency-free Markdown diff with revision history, and a strict revision-ID approval gate.

## Decisions

The following choices were confirmed during the design interview:

1. **Plan inbox lifecycle (`handling = 1`).** Requesting changes keeps the single plan inbox item for the `spec` task and marks it `handling = 1`, moving it to **In progress** (the same pattern used for PR items). When the agent reports a new revision (`kind: "plan"`), the item updates in place with `handling = 0` and returns to **Open**. If the agent stops without submitting a revised plan, Corral's existing idle-fallback capture surfaces the stop.
2. **Client-side comment drafts.** Unpublished comments live in `localStorage`, keyed by `(task_id, revision_id)`. Drafts survive reloads and stay isolated per revision across browser tabs. Comments are persisted to SQLite only when submitted via **Request changes**.
3. **Revision and review persistence.** Store immutable revisions in a new `plan_revisions` SQLite table and submitted feedback batches in `plan_reviews`. Keep `tasks.spec` synced to the latest revision (including its `revision_id` and `children` once approved) so `contractBlock()` and existing readers remain backwards-compatible.
4. **Stale-revision guard on both actions.** Both **Approve plan** and **Request changes** carry `revision_id` and fail with `409 Conflict` when a newer revision exists. On stale **Request changes**, the client preserves the reviewer's draft and offers a one-click jump to compare the stale revision against the latest revision.
5. **Semantic section anchoring.** Render plan bodies with semantic section wrappers (`Contract`, plus nearest sub-heading inside the contract, and `Sub-task: <repo> — <title>`) so the selection toolbar records deterministic section and repo metadata from the DOM.
6. **Dependency-free Markdown diff and revision switcher.** Compare canonical plan Markdown (`planMarkdown(spec)`) with a small line-level diff and an inline word-diff pass on modified lines. Provide a compact revision switcher (`v1`, `v2`, …) in the plan header and a **Changes since vN-1** toggle (defaulting to current vs previous, selectable against any earlier revision).
7. **Dedicated Request changes flow.** Replace the generic "Send & acknowledge" reply box on open plan items with the comment draft panel, an optional general note, and **Request changes**, routed through `POST /api/tasks/:id/request-plan-changes`.
8. **Session delivery boundary.** Deliver revision requests via `WorkerBackend.send`. If the spec session has exited or is unreachable, return an error without flipping `handling` or clearing the draft; do not silently spawn a replacement session in v1. Update `skills/spec.md` so spec agents remain idle after reporting a plan.
9. **Selection toolbar scope.** Show **Comment** alongside **+ New task** only when selecting text in the active open revision's reading view. Elsewhere (older revisions in history, diff views, approved plans, and non-plan items), show **+ New task** only. A tab that loaded `v1` before `v2` arrived keeps its `v1` draft attached to `v1` and hits the `409` guard if the reviewer attempts to submit or approve from that stale tab.

## Domain model and SQLite schema

Additive migrations in `Db.migrate()` (`server/db.ts`):

### `plan_revisions`

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | Opaque UUID (`revision_id`) |
| `task_id` | `TEXT NOT NULL` | References `tasks.id` |
| `version` | `INTEGER NOT NULL` | Monotonic per task (`1, 2, 3, …`), unique on `(task_id, version)` |
| `title` | `TEXT NOT NULL` | Plan report title |
| `contract` | `TEXT NOT NULL` | Markdown contract + delivery order |
| `subtasks_json` | `TEXT NOT NULL` | JSON array of validated `PlanSubtask` entries |
| `markdown` | `TEXT NOT NULL` | Canonical `planMarkdown(spec)` snapshot at submission time |
| `created_ms` | `INTEGER NOT NULL` | Submission timestamp |

### `plan_reviews`

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | UUID |
| `task_id` | `TEXT NOT NULL` | References `tasks.id` |
| `revision_id` | `TEXT NOT NULL` | References `plan_revisions.id` |
| `note` | `TEXT NOT NULL` | Optional general reviewer note (empty string when omitted) |
| `comments_json` | `TEXT NOT NULL` | JSON array of `{ section, repo?, quote, body }` |
| `created_ms` | `INTEGER NOT NULL` | Submission timestamp |

### `tasks.spec` compatibility

Extend `TaskSpec` (`server/types.ts`) with optional `revision_id?: string` and `version?: number`:

```ts
export interface TaskSpec {
  contract: string;
  subtasks: PlanSubtask[];
  revision_id?: string;
  version?: number;
  children?: string[];
}
```

- When `CaptureEngine.createPlan()` records a new plan report, it inserts the next `plan_revisions` row (`version = max + 1`) and writes `{ contract, subtasks, revision_id, version }` to `tasks.spec`.
- Legacy `spec` tasks created before this migration have no `plan_revisions` rows; reading revisions synthesizes a single `v1` entry from `tasks.spec` (or backfills on read/migration), and `contractBlock()` continues reading `tasks.spec` unchanged.
- `approvePlan()` refuses a second approval (`spec.children?.length`) and refuses an already-approved spec from accepting further plan revisions.

## HTTP API contract

Keep `API.md` in sync with `server/api.ts`:

### `POST /api/reports` (`kind: "plan"`)

Unchanged agent request shape (`task_id`, `kind: "plan"`, `title`, `contract`, `subtasks`).

- Refuses reports if the spec task already has approved children (`409 Conflict`).
- Inserts a new `plan_revisions` row with `version = prev + 1`.
- Updates `tasks.spec` to the latest revision.
- Creates or updates the task's single open `plan` inbox item in place: sets `title`, `summary`, `body`, `handling = 0`, `updated_ms = now`, and broadcasts `item.updated` (or `item.created`) plus `task.updated`.
- Records a task event (`Agent proposed plan vN: K sub-tasks`) with `revision_id` and `version`.

### `GET /api/tasks/:id/plan-revisions`

Returns revision history and submitted review rounds for a `spec` task:

```json
{
  "current_revision_id": "<uuid>",
  "approved_revision_id": "<uuid | null>",
  "revisions": [
    {
      "id": "<uuid>",
      "version": 1,
      "title": "...",
      "contract": "...",
      "subtasks": [{ "repo": "...", "title": "...", "prompt": "..." }],
      "markdown": "...",
      "created_ms": 1700000000000
    }
  ],
  "reviews": [
    {
      "id": "<uuid>",
      "revision_id": "<uuid>",
      "note": "...",
      "comments": [{ "section": "Contract > Delivery order", "repo": null, "quote": "...", "body": "..." }],
      "created_ms": 1700000010000
    }
  ]
}
```

### `POST /api/tasks/:id/request-plan-changes`

Request body:

```json
{
  "revision_id": "<uuid>",
  "note": "Optional general feedback",
  "comments": [
    {
      "section": "Contract",
      "repo": null,
      "quote": "POST /orders returns 201",
      "body": "Define idempotency key and retry semantics before splitting repo work."
    }
  ]
}
```

Validation and behavior:

1. Require `task.kind === "spec"`, an existing plan, no `spec.children?.length` (`409` if already approved), and at least one comment or a non-empty `note` (`400` otherwise).
2. Compare `revision_id` against the task's current `revision_id`. If mismatched, return `409 Conflict` with `{ error, current_revision_id, current_version }`.
3. Resolve the agent session address (`task.terminal_address` or the open plan item's `source_ref`). Format the review message and call `WorkerBackend.send(address, message)`.
4. If `WorkerBackend.send` fails (session missing or unreachable), return `409 Conflict` (or `502`) with a clear message and **do not** persist `plan_reviews` or flip `handling`.
5. On successful delivery:
   - Insert the `plan_reviews` row.
   - Update the task's open `plan` item to `handling = 1` and broadcast `item.updated`.
   - Record a task event (`Requested changes on plan vN`) via `logTaskEvent()`.
   - Return `200 OK` with `{ review, item, sent_to }`.

### `POST /api/tasks/:id/approve-plan`

Request body:

```json
{
  "revision_id": "<uuid>"
}
```

Validation and behavior:

1. Require `revision_id` when the plan has a stored `revision_id` (`400` if omitted).
2. Compare `revision_id` against the task's current `revision_id`. If mismatched, return `409 Conflict` with `{ error: "A newer plan revision arrived; review it before approving.", current_revision_id, current_version }`.
3. Otherwise execute the existing `approvePlan()` flow: re-validate subtasks, create child `code` tasks carrying the parent contract, mark the spec task `done`, resolve the open `plan` inbox item, and record `revision_id` + `version` in the approval task event.

## Agent prompt contract

### Formatted Request changes message

Sent through `WorkerBackend.send` and registered in `docs/prompts.md` (so `server/test/prompts-doc.test.ts` stays green):

```markdown
The human requested changes to plan v{version}.

{optional general note}

### Review comments

1. **Section:** {section}
   > {quote}
   {comment body}

Update the contract and sub-tasks to address every comment, then submit the revised plan via `POST /api/reports` with `kind: "plan"`. Do not edit repository files.
```

### `skills/spec.md` update

Clarify step 6 so the spec agent knows:
- After reporting a plan, wait idle for approval or revision feedback (do not exit the session).
- When revision comments arrive, address all of them and submit a fresh `POST /api/reports` with `kind: "plan"`.

## UI and interaction design

### Plan body rendering (`web/src/PlanView.tsx`, integrated into `web/src/pages/Inbox.tsx`)

When the selected inbox item has `kind === "plan"` and a linked `spec` task:

- **Header bar** above the plan body:
  - Revision badge and switcher (`v1`, `v2`, …) when multiple revisions exist.
  - **Changes since v{N-1}** toggle button (available once `version >= 2`), with a compact base-revision selector when `version >= 3` so the reviewer can compare against any earlier revision.
  - Indicator when viewing an older revision ("Viewing v1 — v2 is current") with a quick button to jump to the latest revision.
- **Reading view** (structured plan renderer):
  - Wraps the contract in `<section data-plan-section="Contract">` (and extracts the nearest `h2`/`h3`/`h4` sub-heading inside the contract if the selection falls under one, producing e.g. `Contract > Delivery order`).
  - Wraps each sub-task in `<section data-plan-section="Sub-task: <repo> — <title>" data-plan-repo="<repo>">`.
  - Uses the existing safe `<Markdown />` renderer inside each wrapper (no HTML injection).
- **Diff view**:
  - Computes a line-level LCS/Myers diff over `baseRevision.markdown` vs `targetRevision.markdown` with zero external dependencies.
  - For paired removed/added lines (single-line or small adjacent hunks), runs a token/word-level diff pass to highlight changed spans inline.
  - Renders clear `+` / `-` / context styling and collapses long unchanged runs if needed, without allowing inline comments while in diff mode.

### Selection toolbar (`web/src/SelectionToTask.tsx`)

- Extend the selection anchor check to detect whether the selection starts and ends inside an active, open plan's reading-view container (`[data-plan-commentable="true"]`).
- When inside a commentable plan revision: render a two-action pill with **Comment** and **+ New task**.
- Clicking **Comment** captures `{ id, revision_id, section, repo, quote }` and opens an inline composer (or focuses the comment input in the draft panel) for the reviewer's note.
- Outside active open plan reading views (older revisions, diff mode, approved plans, or any other page/item): render **+ New task** only, preserving existing behavior.

### Draft store and Request changes panel

- Persist drafts in `localStorage` under `corral.planDraft.<task_id>.<revision_id>` as `{ note: string, comments: PlanDraftComment[] }`.
- Display the comment list below the plan (each card showing section, blockquote, editable note, and remove button) plus an optional general note textarea and the **Request changes** button.
- Replace the generic "Send & acknowledge" reply box on open `plan` items with this panel so a reviewer cannot accidentally resolve a plan item via `/api/items/:id/reply`.
- Clear the `localStorage` entry for `(task_id, revision_id)` only after `POST /api/tasks/:id/request-plan-changes` returns `200 OK` (or after the plan is approved).
- If the server returns `409 Conflict` (stale revision) on either **Request changes** or **Approve plan**:
  - Keep the reviewer's `v1` draft intact in `localStorage` and in the UI.
  - Show an inline notice ("Plan updated to v2 while you were reviewing v1") with a one-click **Compare v1 → v2** action that loads `v2` and opens the diff view.
- Previous submitted review rounds (`reviews` from `GET /api/tasks/:id/plan-revisions`) are viewable in a collapsed "Previous feedback" drawer per revision so the reviewer can check whether the agent addressed earlier comments.

## Acceptance criteria and test plan

1. **Multi-revision lifecycle:** Submitting `v1` creates `plan_revisions` row `version = 1` and an open `plan` item. Submitting **Request changes** persists `plan_reviews`, sends the formatted Markdown prompt via `WorkerBackend.send`, and sets `handling = 1` (item moves to **In progress**). Submitting `v2` creates `version = 2`, clears `handling = 0`, and returns the same item to **Open**.
2. **Two-tab stale review and approval:**
   - Tab A loads `v1` and drafts comments on `v1`.
   - Tab B receives `v2` (via SSE refresh) and sees `v2` as current, with no `v1` draft bleed-over.
   - Tab A's draft remains attached to `v1`. Clicking **Request changes** or **Approve plan** from Tab A returns `409 Conflict`, preserves Tab A's `v1` draft, creates zero child tasks, and offers **Compare v1 → v2**.
   - Clicking **Approve plan** from Tab B (sending `v2`'s `revision_id`) succeeds and creates the child `code` tasks.
3. **Diff engine unit tests:** Line additions, deletions, unchanged context, paired-line inline word highlights, and identical revisions ("No changes").
4. **Session unreachable:** When `WorkerBackend.send` throws, `POST /api/tasks/:id/request-plan-changes` returns an error, leaves `handling = 0`, writes no `plan_reviews` row, and the UI keeps the draft.
5. **Backwards compatibility:** Existing `spec` tasks with `tasks.spec` but no `plan_revisions` rows still render, approve, and inject `contractBlock()` into child tasks.
6. **Prompt registry and docs:** `server/test/prompts-doc.test.ts` passes with the new plan-revision prompt registered in `docs/prompts.md`.

## Non-goals for v1

- Auto-spawning a fresh continuation session if the spec agent's session has exited.
- Server-side cross-device synchronization of unpublished comment drafts.
- Guided code-review diffs for PR items (separate future work).
- Allowing approval of an older revision directly (the agent must submit the intended revision as current).
