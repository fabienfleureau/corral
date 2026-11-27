# Scheduled analysis and cleanup of orphaned omnigent sessions

Status: Proposed

Corral dispatches work to omnigent sessions across tasks, KPI cycles, and autonomous epic agents. While [ADR 0012](0012-terminal-tasks-release-worktrees.md) cleans up worktree-backed sessions when a code task reaches a terminal state, live sessions still accumulated in omnigent for several reasons:

1. Non-worktree tasks (`ops`, `review`, `spec`, `analysis`, `grill`) had no `worktree_path`, so `canCleanup` skipped them and left their sessions unarchived.
2. Scheduled KPI cycles (`KpiMonitor.collect`) and epic agent cycles (`EpicAgentRunner.collect`) recorded their reports without archiving their finished sessions.
3. Failed prompt delivery after `POST /v1/sessions` in `OmnigentBackend.start` left a newly created session behind.
4. Re-dispatched tasks and PR follow-up respawns (`respawnForPr`) overwrote `task.terminal_address` without archiving the superseded session.

We fix those leaks at their sources and add a scheduled **Session Cleanup & Diagnosis** job (`server/session-cleanup.ts`) that runs periodically (default every 30 minutes, plus on-demand dry-run or live execution via `GET/POST /api/sessions/cleanup`).

Every scan classifies live sessions by ownership and root cause:

- **External sessions** (no `corral.task` or `corral.harness` label, not recorded in Corral's database, and not a child of a Corral-owned session) are ignored and never modified.
- **Active sessions** (`dispatched` tasks, `done`/`archived` tasks with an open PR item, active KPI/epic cycles, active child sessions, and fresh sessions within the grace window) are kept. Stale `dispatched` sessions that are idle/done/error past the threshold with no open inbox item are surfaced as `stale_dispatched` warnings without auto-killing.
- **Confirmed orphans** (`terminal_task`, `superseded_task`, `missing_task`, `finished_kpi`, `finished_epic_agent`, `orphaned_child`, `unlinked_corral`) are cleaned up via `cleanupFinishedTask` (when eligible), `kill` (when still working), or `archive`.

Run reports and per-reason counts are stored in `session_cleanup_runs` (latest 20 runs) and recorded in `metrics_events`, making both the root causes and cleanup actions visible on `#/sessions`.

Alternatives considered:
- Archiving all idle omnigent sessions regardless of ownership: unsafe because users run non-Corral sessions in the same omnigent host.
- Fixing only the individual leaks without a periodic sweep: leaves existing and crash-induced orphans behind with no diagnosis of why they accumulated.

Consequences:
- Corral-owned orphans are diagnosed by root cause and cleaned automatically on a schedule, while external user sessions and active/open-PR work remain untouched.
- Disabling or tuning the schedule, grace window, or stale warning threshold is configurable via `sessionCleanup` in `config.json`.
