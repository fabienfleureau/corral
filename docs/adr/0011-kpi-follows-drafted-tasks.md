# KPIs follow the impact of tasks drafted from their proposals

Status: Proposed

A KPI cycle proposes improvements, and **Draft task** turns one into a task.
Until now the task kept no trace of its origin, so no cycle could say whether
the shipped change moved the KPI, and the operator had to remember which work
came from which proposal.

A task created from **Draft task** now records the KPI slot and the proposal
title in a separate `kpi_changes` table, keyed by task. The change counts as
shipped the first time the task becomes done, which is when its PR merges or
when a task without a PR is completed; a task archived unfinished never ships.
Each cycle receives the shipped changes it still follows and returns one
verdict per change: visible, none or too early. Corral stops sending a change
after three verdicts other than too early, or 60 days after it shipped.
Changing the KPI's definition or unit clears the verdicts but keeps the links.

The design discussion first placed the link in columns on `tasks`. A separate
table keeps task storage and the task API unchanged for every other caller and
holds the verdict history next to the link. Inferring the origin from the task
prompt would need no storage but break as soon as the operator edits the
prompt. The trade-off is a join on `task_events` to find the shipping date,
and verdicts that rest on the agent's comparison of windows rather than a
controlled experiment.

Report validation and scheduling stay as in [ADR 0005](0005-kpi-scheduling-and-memory.md).
