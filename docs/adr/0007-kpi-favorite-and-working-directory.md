# KPI cycles use a favorite and a working directory

Status: Proposed

KPI cycles configure the agent with the same two picks as an Epic request: a
favorite from Settings and an absolute working directory. The favorite supplies
the harness, agent, model and reasoning; the folder is the session's working
directory with no worktree, because cycles only read data and report. Favorites
are filtered by the folder's professional/personal context, as on the task form.
Settings saved before this change keep their folder and require a new favorite
pick.

The alternative was the original raw harness/agent pair plus a registered
repository. That duplicated the task form's configuration, could not pin model
or reasoning, and refused folders Corral had not registered as git repos — a
real limit for dashboards, logs and read-only data exports. The trade-off is
that a renamed or removed favorite stops the next cycle until the operator
picks another one; Corral reports the error instead of silently choosing a
different agent. Scheduling from [ADR 0005](0005-kpi-scheduling-and-memory.md)
and the workspace memory file from [ADR 0008](0008-kpi-memory-file.md) are
unchanged.
