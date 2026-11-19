# KPI research memory lives in the working directory

Status: Proposed

KPI cycles start a fresh Omnigent session in an operator-chosen folder. Until
now the only durable research memory was a bounded string in the agent's JSON
report, stored in SQLite and repeated in the next prompt. The agent could not
grow or edit it in its own workspace, and the copy in SQLite was the only
visible trace.

Each KPI slot now gets `.corral/kpi-1-memory.md` or `.corral/kpi-2-memory.md` in
its working directory. Corral creates the file from the stored memory on first
use, tells the agent to read and update it, and treats a non-empty file as the
source for the next cycle. SQLite keeps a bounded excerpt for the KPI page and
for cycles that start before any note exists. Changing the definition or unit
deletes the file with the rest of the slot's research. The file is the only
path the cycle may write.

Keeping memory in SQLite alone would cap research at the report field and hide
it from the workspace. A shared file would mix the two independent KPIs even
when they use the same folder. A persistent Omnigent session would keep a
transcript but need a backend-specific recovery contract and would tie memory
to one agent profile. The trade-off is that Corral now writes into a user's
folder and a bad edit to the file survives until the next successful cycle;
the bounded SQLite copy still lets the operator inspect the latest memory.

Scheduling and fresh cycles stay as in [ADR 0005](0005-kpi-scheduling-and-memory.md);
the agent and folder picks stay as in [ADR 0007](0007-kpi-favorite-and-working-directory.md).
