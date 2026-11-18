# Corral owns KPI schedules and analysis memory

Status: Proposed

Corral provides two empty slots for user-defined KPIs and displays the evidence,
open questions and improvement proposals together. Corral stores each definition,
source references, schedule, active cycle, latest report and last sourced measurement
in SQLite. Each cycle starts a
fresh Omnigent session through `WorkerBackend`, with the operator's KPI context
and the previous validated report. The latest accepted report carries a bounded
research memory. Improvements stay proposals until the operator drafts a task.

Omnigent also supports native recurring tasks, including continuing a session
and targeting a managed sandbox where configured. A native schedule would let
cycles fire independently of Corral. It would require synchronizing schedule
state and collecting results from scheduled executions through a backend-specific
contract. A continuously running session would preserve its transcript but make
recovery and context size depend on that session. Fresh cycles keep the research
state explicit, separate the KPIs even if they share an agent profile, and use
the existing backend contract. Automatic cycles require a running Corral server
and an available Omnigent runner. Each monitor allows one active cycle and picks
up due work after restart. Operators own the definitions and connector access.
