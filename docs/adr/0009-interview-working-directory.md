# 0009 — Interview working directory

Status: Proposed

Interview tasks take any existing folder as their working directory, git repo or
not. The New task form has one **Grill me** section with a **With docs**
checkbox; the checkbox selects the existing `grill-docs` task kind. A docs
interview on a git repo keeps its worktree and PR. On a plain folder it writes
directly to that folder and reports what changed as a digest, with no branch,
commit or PR.

Context: interviews often start from notes or a documentation folder that is not
a repository. Dispatch used to reject those paths for both interview kinds,
even though discussion mode never used a worktree. The two task-type buttons
also made the shared interview flow look like two unrelated features.

Alternatives considered: keep requiring a git repo for interviews (blocks the
plain-folder case); run every docs interview in place (loses PR review for the
common repo case); add a separate task kind for folder docs (duplicates the
report and round-handling logic).

Consequence: `grill_docs_output` in the injected interview convention tells the
agent which finish flow applies. A plain-folder docs interview is visible only
through the inbox digest, so it must name every file it changed.
