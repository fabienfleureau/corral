# Working with Corral

You are running inside **Corral**, a personal dispatch-and-review app. Corral sent
you this task and is watching your status. A human is reviewing and answering from
their inbox — they never read your transcript.

## When the work is done: finish automatically (do not ask)

Reaching the end of the task is NOT a decision point. When your work is done and
tests pass, **do all of this without asking permission**:

1. **Commit** your changes (meaningful message; one commit per logical change).
2. **Push** the branch to `origin`.
3. **Open the PR/MR**: `gh pr create` (GitHub) or `glab mr create` (GitLab) with a
   title and a body covering what changed, why, and how to test it.
4. **Report the result** so it reaches the human's inbox with the link:

```sh
curl -s -X POST "$CORRAL_URL/api/reports" \
  -H "Authorization: Bearer $CORRAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"task_id\":\"$CORRAL_TASK_ID\",\"kind\":\"done\",\"title\":\"<PR title or: work complete>\",\"body\":\"<2-5 sentences: what was done, how to test it>\\n\\nPR: <url>\"}"
```

Only report a question (below) if finishing is genuinely **blocked** — no remote
configured, push rejected, tests failing and you cannot fix them. Say what you
tried.

## If you need the human mid-task: report it — don't guess

When you are blocked on a question, a decision, or a permission **while working**,
stop and ask. Do not pick an option on the human's behalf.

```sh
curl -s -X POST "$CORRAL_URL/api/reports" \
  -H "Authorization: Bearer $CORRAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"task_id\":\"$CORRAL_TASK_ID\",\"kind\":\"question\",\"title\":\"<one-line question>\",\"body\":\"<the FULL question, markdown>\",\"options\":[\"<option A>\",\"<option B>\",\"none\"]}"
```

Then **wait** for the answer to arrive as input. Keep working only on parts that
are not blocked by the question.

If `curl` is unavailable, just ask in your output and stop — Corral's fallback
capture will pick you up when you go idle.

## What makes a good report

- `title`: the actual question or outcome in one line ("Use Postgres or SQLite
  for the cache?", "PR: jira import preview + review step").
- `body`: **complete, not a teaser.** The inbox shows this and only this —
  include everything needed to decide or review: context, options with
  trade-offs, your recommendation first, diffs/tables/code blocks (markdown is
  rendered). For completion reports: what changed, how to test, and the PR link.
- `options` (questions only): the discrete answers the human can reply with in
  one click (2-8 short strings, e.g. `["all", "1,3", "none"]`). Include an
  explicit "none"/"cancel" whenever an action is proposed.
- One report per decision. Do not batch five questions into one item.

## Report once

When the human answers, act on it — do not re-report the same question. If new
information changes the decision, post a NEW report referencing the old one.
