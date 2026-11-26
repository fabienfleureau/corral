# Share redacted Markdown evidence from the browser

Status: Proposed

## Context

Inbox reports and task history are how a finished investigation, spec plan or PR
review is read back. They can quote `$HOME` and worktree paths, bearer tokens
copied from a log, and verbatim shell transcripts. The human sometimes needs to
share that evidence in Slack, Jira or GitHub. Corral keeps SQLite, agent context
and the HTTP API on `127.0.0.1`; the raw context drawer is deliberately local
only (see [architecture](../architecture.md#trust-and-operational-limits)).

## Decision

Add **Copy Markdown** and **Download .md** actions to inbox reports and the task
history dialog. A pure helper in `shared/redacted-markdown.ts` runs in the
browser before either action: it replaces local paths (`$HOME`, worktrees,
Windows paths, `file://` URLs), credential values (`Authorization`/Bearer,
named tokens and secret query parameters) and shell transcripts. The raw agent
context is never part of an export. Both actions use the same text, so a
downloaded file matches what was copied.

## Alternatives and trade-offs

- **Server-side export endpoint**: centralizes the rules but adds an
  authenticated endpoint and another place sensitive text is handled. It does
  not improve safety for a single-user local app.
- **Copy the rendered report as-is**: trivial, but it carries exactly the paths,
  tokens and terminal output the human cannot paste safely.
- **Publish to Slack/Jira/GitHub from Corral**: rejected. Destination and
  audience are human decisions, and Corral has no identity on those platforms.

Redaction is best-effort pattern matching, not a guarantee: a human still reads
the result before pasting it. Keeping the whole flow in the browser adds no new
trust boundary, no upload and no persisted export.
