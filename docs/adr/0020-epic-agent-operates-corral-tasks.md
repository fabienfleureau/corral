# Epic autonomous agent operates through real Corral tasks and statuses

Status: Proposed

[ADR 0017](0017-epic-autonomous-agent.md) introduced the opted-in autonomous epic implementation agent, and [ADR 0018](0018-epic-agent-creates-tasks.md) moved task creation from epic import to that agent while leaving created tasks open for manual human launch. In practice, that left two gaps: the epic agent could edit code directly in its working directory without a tracked Corral task, and it could not move task or Jira statuses when interacting with epic tasks.

When the opted-in autonomous epic agent interacts with epic tasks, it now operates through real Corral tasks just like a human operator:

- Create concrete Corral tasks via `POST /api/epics/:id/tasks` in the right repository with the right favorite or harness/agent (and `jira_key` when tied to a synced Jira child ticket), instead of silently implementing epic task work outside Corral.
- Launch ready Jira-linked epic tasks via `POST /api/epics/:id/tasks/:taskId/launch` (preserving blocker checks, stacked `base_branch` selection, worktree creation, saved `agent` settings, and Jira `"In Progress"` sync), and dispatch non-Jira epic tasks via `POST /api/tasks/:id/dispatch`.
- Maintain task and Jira statuses as work progresses: send follow-up guidance via `POST /api/tasks/:id/instruct`, refresh PR readiness and Jira review stages via `POST /api/tasks/:id/check-pr`, resync Jira via `POST /api/epics/:id/sync`, and move tasks to `done` or `archived` via `PATCH /api/tasks/:id` (marking a Jira-linked code/ops task `done` now also triggers best-effort forward Jira `"Done"` sync and refreshes the epic board, as does `POST /api/jira/tasks/:id/done`).

Importing or resyncing an epic still never creates or auto-starts tasks, preserving [ADR 0002](0002-epic-tasks-start-from-epic-page.md) and the import half of [ADR 0018](0018-epic-agent-creates-tasks.md). The trade-off is that enabling or running the autonomous epic agent now grants it the ability to launch and advance tasks on that epic through Corral's API, which is explicit opt-in per epic and keeps every action visible in the Tasks queue, Epic board, PR loop, task history, and Jira.
