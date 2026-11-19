# Killed Jira tickets are terminal, not merged

Jira can mark an epic ticket **Killed** because the work was cancelled or moved elsewhere. Corral used to read only its "done" statuses, so a killed ticket stayed "ready to launch" and kept its dependents blocked forever. Counting it as merged would be wrong too: its branch and PR are abandoned, and the progress summary would claim shipped work.

A resync that sees `Killed` now shows the ticket in a killed group. The ticket is terminal: it is excluded from the epic summary and design amendments, cannot be launched, and stops blocking its dependents. A dependent whose prerequisite was killed shows a note on the epic and may be launched. Corral never writes the Killed status itself; Jira stays the source of truth (ADR 0001).
