# Terminal tasks release their worktree and branch

Status: Proposed

Corral asks omnigent to create a worktree and branch for each dispatched code
task. Until now only an explicit `POST /api/tasks/:id/cleanup` removed them, so
archived and done tasks left worktrees and local branches behind. Archiving a
session deliberately kept its worktree, and a merged PR archived the inbox item
without freeing the branch.

Corral now removes a task's worktree and local branch when the task reaches a
terminal state (`done` or `archived`) and no PR item is still open. A merged or
closed PR resolves its item and runs the same cleanup. A periodic sweep after PR
sync retries tasks that were already terminal or whose first cleanup failed.
Cleanup is best effort: a failure leaves `worktree_path` on the task so a later
pass can retry. The branch name stays on the task as a record of what was
delivered; only the git branch and worktree are removed.

An open PR item blocks cleanup because the PR loop still needs the branch to
read comments, rebase conflicts and respawn an agent. Cleaning on every `done`
report would delete the branch of a PR that has only just been opened.

Alternatives considered: leave cleanup fully manual (keeps the leak), delete on
any terminal status (breaks the PR loop), or have Corral run `git worktree
remove` itself (duplicates omnigent's git ownership and its branch bookkeeping).
The chosen rule keeps worktree ownership in the `WorkerBackend` seam and the
decision in Corral. With the omnigent backend, removing the worktree also
deletes the session, so a cleaned task's Omnigent inspect link no longer works;
that matches the existing manual cleanup action.
