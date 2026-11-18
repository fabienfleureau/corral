# Architecture decision records

[Architecture](../architecture.md) · [Contributing](../../CONTRIBUTING.md)

ADRs explain consequential product and engineering choices: the context, what
we chose, and why. They preserve reasoning that the code alone cannot show.
They are required when a change makes or revisits such a decision.

## Decisions

| Record | Status | Topic |
|---|---|---|
| [0001](0001-jira-source-of-truth-for-epics.md) | Accepted | Jira owns epic tickets; Corral writes delimited blocks |
| [0002](0002-epic-tasks-start-from-epic-page.md) | Accepted | Epic tasks wait for explicit launch from the Epic page |
| [0003](0003-record-consequential-decisions.md) | Accepted | Record consequential decisions in the same PR |
| [0004](0004-agent-control-mcp.md) | Proposed | Agent control uses three MCP tools on the Corral HTTP server |
| [0005](0005-kpi-scheduling-and-memory.md) | Proposed | Corral owns KPI schedules and analysis memory |

Records 0001 and 0002 predate this index and retain their original concise text.
Their status here reflects the repository's existing product rules.

## When a record is required

Use an ADR when the decision has a meaningful reversal cost, needs context to
make sense to a future maintainer, and involves real alternatives. Examples:

- Changing the ownership boundary between Corral and omnigent or Jira.
- Choosing storage, an execution backend, or an integration pattern with
  lasting coupling.
- Changing established launch, approval or PR readiness semantics.
- Replacing a previously accepted decision.

A copy fix, routine bug fix, test addition or mechanical extraction does not
need an ADR unless it makes one of these decisions. Do not create records just
to justify an implementation detail or backfill imaginary historical debates.

Every PR must reference the applicable ADR(s), or provide a specific reason why
no ADR is needed. An existing record suffices when the change implements an
already recorded choice. Reviewers enforce relevance and reasoning; a template
or CI check cannot decide whether an architectural change was omitted.

## Writing and maintaining a record

1. Copy [template.md](template.md). Choose the next unused four-digit number
   and a lowercase slug: `NNNN-short-decision.md`, starting at `0001`.
   Check for parallel PRs allocating the same number before merging.
2. Write the actual context, decision and reason. A title and a short paragraph
   can be enough. Include alternatives and consequences where they explain a
   real trade-off. Link to implementation or the PR when useful.
3. Add the record to this index in the same PR. New choices start **Proposed**
   and become **Accepted** through human review and merge. A decision explicitly
   approved before implementation may already be marked Accepted.
4. Correct factual errors in place. To change a decision, add a new record and
   mark the previous one **Superseded by ADR NNNN**, with a link. Use
   **Deprecated** when it no longer applies without a replacement. Keep old
   filenames and the reasoning available; never renumber records or reuse IDs.
5. Run `npm run check:adr`.

The validator checks names, unique nonzero IDs, titles, nonempty bodies, and
index links. It accepts paragraph-only records; it does not require boilerplate
sections, determine whether the decision is wise, or enforce GitHub branch
protection. CI runs it alongside tests, types, and the build.
