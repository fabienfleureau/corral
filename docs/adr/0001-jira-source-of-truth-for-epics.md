# Jira is the source of truth for Epics; Corral writes only delimited blocks

An Epic mirrors a Jira epic: Jira owns tickets, "blocked by" links, titles and descriptions, and Corral keeps in sync after creation. Corral owns execution (PRs, progress, repo per task) and the Design version history. It writes back to Jira only statuses and two delimited description blocks (current Design on the epic, current Amendment on a ticket), after human validation. Each block holds a single version, replaced on revision, so agents rereading a ticket never see stale versions. Keeping the amendment only in Corral was rejected: the ticket would stop telling the truth to teammates.

Dependencies are the Jira links; non-status conditions are written as text in the ticket and checked by the agent at start.
