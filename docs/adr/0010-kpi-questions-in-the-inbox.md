# KPI questions go to the inbox and answers stay with the KPI

Status: Proposed

KPI cycles report data needs and product questions. Until now they only showed
in the KPI tab, which an operator opens rarely, so a missing export could block
a KPI for weeks without anyone noticing. Inbox items, on the other hand, always
answer a live agent session: a reply is sent to the item's session or task.
A KPI cycle's session has ended by the time the operator reads its report.

Each data need and product question now carries an id the agent keeps across
cycles. Corral opens one inbox question per new id, with `kpi:<slot>:<id>` as
its source reference, and archives the item when a later report drops the id.
A reply to such an item does not go to a session: Corral records it, with the
question, in the KPI's feedback list (bounded, in SQLite) and resolves the
item. Every later cycle receives that list, as do ideas the operator dismissed
on the KPI page. A reply does not start a cycle; the next scheduled cycle or
**Run now** reads it. Changing the definition or unit clears the feedback and
archives the KPI's open items.

Keeping the questions in the KPI tab would avoid a second reply path but keep
them invisible. Starting a cycle per reply would answer faster but cost one
agent run per answer, when answers usually come in batches. Writing answers
into the operator's free-text product context would reuse an existing field
but overflow its limit and mix the operator's text with Corral's. The
trade-off is that the inbox reply endpoint now has a branch that never reaches
an agent, and an id the agent renames is asked again.

Scheduling and fresh cycles stay as in [ADR 0005](0005-kpi-scheduling-and-memory.md);
the memory file stays as in [ADR 0008](0008-kpi-memory-file.md).
