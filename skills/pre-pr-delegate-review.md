# Review your diff before opening the PR/MR

Before opening the PR/MR, have the `{review_agent}` sub-agent review your changes. It is a separate read-only session in this working directory: it reads your commits and your uncommitted changes itself and edits nothing.

1. Call the omnigent tool `sys_session_send` with `agent` = `{review_agent}`, `title` = `review-1` and `args` = `{"purpose": "review", "input": "Review the changes in this repository. Base ref: {base_branch}"}`. Then end your turn: omnigent wakes you when it finishes. Collect the reply with `sys_read_inbox`.
2. The reply is one JSON object, `{findings, coverage}`. Read every finding. Fix it, or write one line saying why you decline it.
3. After your fixes, review once more with a new title (`review-2`). Stop after two rounds.
4. Add a "Review" line to the PR description: the sub-agent, the number of findings, how many you fixed, how many you declined and why.
5. If `sys_session_send` is missing, the sub-agent fails or never answers, say so in that line and in the completion report. Never claim a review ran when it did not, and do not run `ocr` yourself instead.
- An empty `findings` array is a clean review. Check `coverage.skipped_files`: those files were not reviewed.
