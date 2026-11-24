# Tasks with an open PR stay open until it merges or closes

Status: Proposed

## Context

An agent's `done` report marked its task done at once, and so did the end of
its session. Thirty days of activity showed tasks marked done while their PR
was still open (qovery-cli#801, rust-backend!775), and done tasks whose PR was
closed unmerged (corral#168, engine!3117). The task list could not tell
delivered work from abandoned work. AGENTS.md already says that merged PRs
complete their task.

## Decision

A `done` report on a task whose PR the loop follows (code tasks, and
grill-docs tasks that report a PR) no longer marks the task done. The task
keeps its status, the report is noted in `pr_meta.done_reported_ms`, and the
PR sync decides:

- PR open: the task stays as it is. The end of the session does not complete
  it either (`onFinished` looks the PR up first).
- PR merged: the task is done with outcome `merged`.
- PR closed unmerged: the task is done with outcome `closed`. This applies only
  when the agent reported done or the task is already done. A task the agent
  is still working on keeps going, since it may open another PR.
- No PR found: the task is done with outcome `reported`.

Tasks get an additive `outcome` column: `merged`, `closed`, `reported` or null.
No new status values. Review, spec, analysis, ops and grill tasks are never
PR-synced. Their done report still completes them, now with outcome `reported`.
A done or archived task still records the outcome its PR settles. A task moved
back to open or dispatched loses its outcome. A human can still mark any task
done by hand; that leaves the outcome null.

The human did not answer this choice explicitly. The agent took it as the
default most consistent with "merged PRs complete their task", so it is open
to revision.

## Consequences

- A task waiting for review or merge shows as dispatched, not done.
- Its worktree is kept until the merge: cleanup needs a done task and no open
  PR item (ADR 0012). The PR loop still needs the branch for review comments
  and conflicts.
- Epic dependents wait for the merge, because the epic graph treats a done
  task as delivered. Before this change they could start on an unmerged PR.
- A held task has an open PR item, so the stopped-run retries (ADR 0016) do
  not nudge its idle session.
- If the PR lookup fails at report time, the task is completed as `reported`
  (the previous behavior), not held.

## Alternatives

- A new `in_review` status: clearer in lists, but it changes every status
  check, filter and the epic agent's vocabulary. The outcome column is
  additive.
- Mark done at report and reopen when the sync sees an open PR: the status
  would flip, and the sync could not tell this from a human marking the task done.
