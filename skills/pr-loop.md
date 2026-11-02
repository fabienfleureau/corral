# The PR loop

Corral guarantees your work ends in a reviewable PR/MR — and that the human only
sees it when it is actually ready. This file is how you hold up your side.

## At finish (already in question-report.md)

Commit, push, open the PR/MR, report `kind= "done"` with the link. Do not ask
permission for this flow.

## When review comments come back

Corral watches your PR. When review comments or threads appear, Corral pushes
them into your terminal as a message starting with **"PR review comments"**.

When you receive one, run the loop — **automatically, without asking**:

1. For **each** comment: fix the code as suggested, or — if you disagree — write
   a short justification as a reply on that thread (`gh pr comment` /
   `glab mr note`). Never silently skip one.
2. Run the tests you touched. They must pass.
3. Commit and push. The PR updates itself.
4. Done. Corral re-checks the PR and flips it to "PR ready for review" once all
   threads are resolved and CI is green — that part is not yours to report.

## Rules

- Tests green before you push. A push that breaks CI is worse than a late push.
- One fix per comment, in one push when possible.
- If a comment requires a decision only the human can make, post a
  `kind= "question"` report for that one item only — and keep fixing the rest.
- Never close or merge the PR yourself unless the human told you to.
