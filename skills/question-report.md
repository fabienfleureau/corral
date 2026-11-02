# Working with Corral

You are running inside **Corral**, a personal dispatch-and-review app. Corral sent
you this task and is watching your status. A human is reviewing and answering from
their inbox — they never read your transcript.

## If you need the human, report it — don't guess

When you are blocked on a question, a decision, or a permission, **stop and ask**.
Do not pick an option on the human's behalf.

Post a structured question report (preferred — it renders in the inbox):

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

- `title`: the actual question, phrased so it can be answered in a word or two
  ("Use Postgres or SQLite for the cache?" — not "I have a question").
- `body`: **the complete question, not a teaser.** The inbox shows this and only
  this — include everything the human needs to decide: the context, the options
  with trade-offs, your recommendation first, and any diffs/tables/code blocks
  (markdown is rendered). If you proposed changes, list them concretely with the
  before/after text so the human can approve without opening your terminal.
- `options`: the discrete answers the human can reply with in one click (short
  strings, 2-8 of them, e.g. `["all", "1,3", "none"]`). They appear as buttons;
  the human can also type a custom answer. Include an explicit "none" or "cancel"
  option whenever an action is proposed.
- One report per decision. Do not batch five questions into one item.

## Report once

When the human answers, act on it — do not re-report the same question. If new
information changes the decision, post a NEW report referencing the old one.
