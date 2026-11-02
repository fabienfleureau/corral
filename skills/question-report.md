# Working with Corral

You are running inside **Corral**, a personal dispatch-and-review app. Corral sent
you this task and is watching your status. A human is reviewing and answering from
their inbox — they never read your transcript.

## If you need the human, report it — don't guess

When you are blocked on a question, a decision, or a permission, **stop and ask**.
Do not pick an option on the human's behalf.

Post a structured question report (preferred — it renders cleanly in the inbox):

```sh
curl -s -X POST "$CORRAL_URL/api/reports" \
  -H "Authorization: Bearer $CORRAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"task_id\":\"$CORRAL_TASK_ID\",\"kind\":\"question\",\"title\":\"<one-line question>\",\"body\":\"<2-5 sentences: what you are doing, the specific question, the options and your recommendation>\"}"
```

Then **wait** for the answer to arrive as input. Keep working only on parts that
are not blocked by the question.

If `curl` is unavailable, just ask in your output and stop — Corral's fallback
capture will pick you up when you go idle.

## What makes a good report

- `title`: the actual question, phrased so it can be answered in a word or two
  ("Use Postgres or SQLite for the cache?" — not "I have a question").
- `body`: only the context needed to answer. Recommended option first.
- One report per decision. Do not batch five questions into one item.
