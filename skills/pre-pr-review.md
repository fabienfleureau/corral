# Review your diff before opening the PR/MR

Run the review from the worktree root before opening the PR/MR:

```sh
{review_command}
```

- Read every finding. Fix it, or write one line saying why you decline it.
- Run the command again after your fixes. Stop after two rounds.
- Add a "Review" line to the PR description: the command, the number of findings, how many you fixed, how many you declined and why.
- If the command is missing, fails or times out, say so in that line and in the completion report. Never claim a review ran when it did not.
- A non-zero exit code can mean "findings", not "failure": read the output.
