# KPI status artifacts run as Claude tasks

Status: Proposed

The KPI page already holds sourced measurements, report prose, goals and
proposals, but it is a monitoring surface: it has no shareable summary for a
team update. The team needs a one pager or short slides covering the value,
the evolution and why, work done and its impact, and the next steps.

The page now offers a **Build team artifact** action. It opens a picker for the
format and the angles to cover, then calls `POST /api/kpis/:id/artifact`. Corral
builds one prompt from the saved KPI reports, frames the report text as data,
and dispatches a fresh `ops` task on the Claude harness. The task reports the
private artifact URL to the Corral inbox through the existing ops convention,
so the request is trackable and the human controls sharing. The KPI's favorite
is reused when it is Claude; otherwise the first configured Claude favorite in
the same context is used.

Generating Markdown locally would avoid an agent, but it would only restate the
report fields and could not produce a Claude artifact or slides. Sending a
follow-up to the last KPI cycle's Omnigent session would reuse a session that
may already be finished, with no task record and no inbox report. A dedicated
task keeps Corral's dispatch and inbox boundaries intact at the cost of one
extra agent run per artifact. The prompt never writes to the repository: the
artifact lives in Claude, and only its URL comes back.

The report is a point-in-time copy. A change to a KPI after dispatch does not
update an artifact already built; the human builds a new one.
