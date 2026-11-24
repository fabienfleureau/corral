# Flag repeatedly snoozed inbox items, observe only

Status: Proposed

## Context

Thirty days of activity showed inbox items the human keeps putting off: a
question open about 4.5 days and snoozed twice, a ready PR open about 4.5 days
and snoozed twice, several work MR items snoozed together. A snooze hides the
item until its deadline and then it comes back looking like any other item, so
nothing tells the human it has already been put off. Corral only recorded each
snooze as an `item.snoozed` metric.

## Decision

Count snoozes per item and surface the count; take no automatic action.

- `items.snooze_count` is an additive column, incremented by
  `POST /api/items/:id/snooze` and backfilled once from `item.snoozed` metrics.
- At 2 snoozes or more the inbox row shows a `snoozed N×` badge, and the item
  sorts ahead of the other items of its list (Open or Snoozed). Order is kept
  otherwise.
- The improvement evidence flags such items (`snoozed_repeatedly`) and counts
  them in `data_quality.repeatedly_snoozed_items`.

This choice was made by default, without a product discussion, following the
observe-only stance of [ADR 0019](0019-pr-risk-triage-observe-only.md). The
human can revisit it.

## Alternatives and trade-offs

- **Act automatically** (escalate, refuse a third snooze, auto-archive, ping
  the agent): rejected for now. Each changes inbox semantics the human owns,
  and a snooze can be a deliberate wait on someone else.
- **Derive the count from metrics on every read**: no schema change, but every
  item list would scan the metrics log. A counter is cheap to read and the
  backfill keeps history.
