# Antigravity idle status is verified against local agy

Status: Proposed

## Context

Omnigent 0.23.0's `antigravity_native` RPC reader (`reader.py`) closes an active
turn and emits `external_session_status: "idle"` whenever a streamed
`CORTEX_STEP_TYPE_PLANNER_RESPONSE` step settles with assistant text and no
`plannerResponse.toolCalls`. Because `StreamAgentStateUpdates` strips
`toolCalls`, models that emit mid-turn progress text alongside tool calls cause
Omnigent to mark a live session `idle` while `agy` is still working, and
`reader.py` never re-emits `running` until a new `USER_INPUT` step arrives.

In Corral, that false `idle` removes active Antigravity tasks from the inbox's
**In progress** tab and causes `CaptureEngine` ([ADR 0016](0016-stopped-agent-retry-policy.md))
to treat the turn as stopped and send automatic nudges or escalate an active
agent to the inbox.

## Decision

When `OmnigentBackend.list()` or `OmnigentBackend.get()` sees a live (`state !==
"finished"`) Antigravity session with `status === "idle"`, Corral passively
cross-checks running local `agy` Connect-RPC language servers via
`GetAllCascadeTrajectories` in [`server/antigravity-status.ts`](../../server/antigravity-status.ts)
and upgrades `session.status` to `"working"` when its cascade still reports
`CASCADE_RUN_STATUS_RUNNING` (including running subagent child cascades that
point back to the root/parent conversation):

- **Strict passivity:** The probe only inspects already-running `agy` processes
  from `ps`/`lsof` and never spawns `agy` (unlike the quota check in
  `server/google-quota.ts`).
- **Identity matching:** Sessions match primarily by Omnigent's
  `external_session_id` against `trajectorySummaries` (an explicit idle entry for
  that cascade overrides any fallback), falling back to the parent `tmux`
  command's `@omnigent-conversation-link` session id when `external_session_id`
  is absent or not yet bound.
- **Bounded & cached:** Probes share a 2 s TTL single-flight cache with a 1.5 s
  deadline and fail open to the unadjusted Omnigent status on any process, RPC,
  or timeout failure, and skip the probe altogether when no live Antigravity
  session is reported `idle`.

## Alternatives considered

- **Wait solely for an upstream Omnigent fix:** Leaves Corral auto-nudging and
  hiding active Antigravity tasks whenever `agy` emits mid-turn progress text.
- **Post `external_session_status: "running"` back into Omnigent:** Mutates
  Omnigent's own session state from outside, risks racing Omnigent's reader, and
  violates the boundary that Corral reads agent state rather than writing
  synthetic runner events.
- **Suppress `idle` purely inside Corral from conversation items:** Cannot tell
  whether an in-flight tool or subagent actually finished without querying `agy`
  itself.

## Consequences

- Corral's **In progress** list, session status polling, and `CaptureEngine`
  retry/escalation loop stay accurate while local `agy` is still working.
- Omnigent's own web UI loader icon is governed by Omnigent's server cache and
  is unaffected by this Corral-side workaround.
- Remote-host `agy` processes are unreachable on loopback and fail open to
  Omnigent's reported status. Once Omnigent drives `running`/`idle` from `agy`'s
  cascade run status, this probe can be removed without schema or API impact.
