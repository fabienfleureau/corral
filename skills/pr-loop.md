# The PR loop

Corral guarantees your work ends in a reviewable PR/MR — and that the human only
sees it when it is actually ready. This file is how you hold up your side.

## At finish (already in question-report.md)

Commit, push, open the PR/MR, report `kind= "done"` with the link. Do not ask
permission for this flow.

## UI changes

For visible UI changes, capture comparable before-and-after views with the same
viewport and representative, non-sensitive data. Include labeled screenshots in
the PR description. Capture the base and the changed version, and check the
images before uploading them; do not use the live application as a stand-in for
either version.

Use the repeatable fixture and capture commands in `AGENTS.md` under
“Repeatable UI screenshots”.

On macOS in the Codex sandbox, request permission to run the capture outside
the sandbox before starting Chrome; launching it inside can trigger a macOS
crash dialog even in headless mode.

On GitHub, `gh pr create` and `gh pr edit` support `--attach` (gh 2.99 or
later). For example, add `--attach './before.png#Before'` and
`--attach './after.png#After'` to the command. GitHub hosts the images and appends them to
the description. Fetch the saved PR description and verify both images are
present. Do not commit screenshots just to make them accessible.

If headless Chrome exits without producing an image in a sandbox, try an
available browser tool or request the sandbox's supported permission to run the
capture outside it. Use a separate temporary browser profile. If capture or
upload still fails, state the specific failure in the PR and completion report;
never claim a visual check passed without reviewing the images.

## After every push: keep the title and description current

Opening the PR/MR is not the end of its description. After **each** push — a
review fix, a rebase, a change of approach — re-read the title and body against
what the branch now does and rewrite whatever went stale (`gh pr edit` /
`glab mr update`): scope, files touched, risk, how to test, the screenshots that
are actually in it. Corral shows the PR/MR description at the top of the inbox
item the human reviews, so a body left as written when the PR opened is the only
description they will read. If the new commit changed a claim the body makes,
change the claim in that same push — a stale body is a stale review.

## When review comments come back

Corral watches your PR. When review comments or threads appear, Corral pushes
them into your terminal as a message starting with **"PR review comments"**.

When you receive one, run the loop — **automatically, without asking**:

1. For **each** comment: fix the code as suggested, or — if you disagree — reply
   on that thread saying why not (`gh pr comment` / `glab mr note`). One or two
   lines: what changed and where, or why not. No apology, no restating the
   comment. Never silently skip one.
2. **Resolve the thread you fixed** — a reply alone does not resolve it on
   GitHub:
   `gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:"<id>"}){thread{isResolved}}}'`
   (the message Corral sends you carries each thread's id). Do **not** resolve a
   thread you only replied to: Corral counts the reply as an answer, so the gate
   clears without it, and resolving a human's thread you disagree with silences
   the disagreement instead of settling it.
3. Run the tests you touched. They must pass.
4. Commit and push. The PR updates itself.
5. Done. Corral re-checks the PR and flips it to "PR ready for review" once all
   threads are answered or resolved and CI is green — that part is not yours to
   report.

## When the PR has merge conflicts

When the PR stops merging cleanly into its base, Corral pushes a message
starting with **"PR merge conflicts"** (it may be combined with review
comments in one message). Handle it **automatically, without asking**:

1. `git fetch origin && git rebase origin/<base>` (the message names the base).
2. Resolve each conflict keeping the intent of both sides, then
   `git add` + `git rebase --continue`.
3. Run the tests you touched. They must pass.
4. `git push --force-with-lease`.
5. Only if a conflict needs a product decision you cannot make, post a
   `kind= "question"` report for that one conflict.

If you are a **fresh session continuing someone else's work**, you were given a
handoff document. Trust it for intent and decisions, verify it against the code
before fixing, and update the humans through the same report channels.

## Rules

- Tests green before you push. A push that breaks CI is worse than a late push.
- One fix per comment, in one push when possible.
- If a comment requires a decision only the human can make, post a
  `kind= "question"` report for that one item only — and keep fixing the rest.
- Never close or merge the PR yourself unless the human told you to.
