# MCP exposes inbox triage inspection and soft triage actions

Status: Proposed

[ADR 0004](0004-agent-control-mcp.md) introduced three voice-oriented MCP tools
(`corral_next`, `corral_create_task`, `corral_instruct`) over `POST /api/mcp`.
When a developer pairs Corral with a persistent external assistant (such as an
OpenBot triage agent), a one-line `corral_next` summary is not enough to sort
an overloaded inbox into what blocks an agent now, which PRs are ready to
review, and what can be snoozed or acknowledged.

Corral extends `server/agent-control.ts` with four inbox-triage tools:

- `corral_inbox_list` (read-only): lists open inbox items grouped by triage
  priority (`blocking`, `ready_pr`, `waiting_pr`, `other`), promotes items
  snoozed 2+ times into `blocking`, includes linked task metadata and PR risk
  triage, and omits raw terminal transcripts (`item.context`).
- `corral_item_detail` (read-only): inspects one item by id or prefix (>= 4
  chars) with bounded `summary`/`body` and recent task events, omitting
  `item.context` and raw event payloads.
- `corral_snooze_item` (soft triage): snoozes an open item for 5–10080 minutes
  (default 60) and broadcasts `item.updated`.
- `corral_ack_item` (soft triage): acknowledges (`resolved`) an open item,
  cancels stopped retries, updates review-question outcomes via
  `reviewQuestionClosed`, and broadcasts `item.updated`.

Dispatching tasks, replying to agent questions or permission prompts, and
merging PRs remain human-owned and are intentionally excluded from the MCP
surface.

The alternative was having external agents call the raw REST endpoints
(`/api/items`, `/api/tasks/:id/events`, `/api/items/:id/snooze`) with ad-hoc
scripts. Exposing them as typed MCP tools keeps the prompt-injection boundary
(`MCP_INSTRUCTIONS`), bounds payload sizes, strips `item.context`, and lets any
MCP-capable client discover and invoke triage safely.
