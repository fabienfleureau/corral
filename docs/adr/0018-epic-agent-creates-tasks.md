# Epic import does not create tasks; the epic agent creates them

Status: Proposed

Importing or resyncing a Jira epic (`syncEpic` in `server/epic.ts`) previously inserted a Corral task in the `tasks` table for every child Jira ticket. That immediately populated the Tasks queue with open tasks that had no harness/agent selected and only a best-effort repository guess from a `Repo:` line, before anyone decided how the epic should be split across repositories and agents.

Epic import and resync now store the epic's Jira child tickets as reference data in `epic_tickets` (alongside `epic_links`) without creating rows in `tasks`. Any already-existing Corral task matching a child `jira_key` is still attached and kept in sync.

Instead, the autonomous epic agent ([ADR 0017](0017-epic-autonomous-agent.md)) receives the synced `jiraTickets`, existing epic `tasks`, registered `repos` (with context), configured `favorites` and `harnesses`, and the authenticated `POST /api/epics/:id/tasks` endpoint. When the agent identifies concrete work, it creates open Corral tasks linked to the epic in the right repository (by registered repo name or absolute path) with the right agent (`favorite` or explicit `target` + `agent`, and optional `jira_key` to link Jira metadata and prevent duplicates). Created tasks remain open for human launch, preserving [ADR 0002](0002-epic-tasks-start-from-epic-page.md).

The trade-off is that a newly imported epic starts with zero Corral tasks on its board until the epic agent (or a human) creates them, while keeping the Tasks queue clean and ensuring each created task targets the intended repository and agent.
