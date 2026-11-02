# Clarify a ticket (companion skill)

Use this when you have a Jira ticket (an idea / epic) and want to turn it into
implementation tasks. Corral does **not** do this step — you run this skill in an
agent session, review the output, and create the subtasks in Jira yourself.
Corral's JQL import then picks them up.

## Steps

1. Fetch the ticket and read it fully (summary, description, comments, links).
2. Ask the human any question whose answer would change the breakdown
   (scope, constraints, deadline, what "done" means).
3. Produce 1..N subtasks. For each:
   - **title**: verb-first, one line, no ambiguity ("Add `last_seen` column to `users`")
   - **description**: what to change, where, and why; acceptance criteria as a checklist
   - **size**: S / M / L; anything bigger than L must be split further
   - **dependencies**: which subtasks block which
4. Check the set: does implementing all of them close the parent ticket? If not,
   say what's missing. If two subtasks would touch the same code path, say so.
5. Output the subtasks as markdown, ready to paste into Jira.

## Rules

- Prefer more small tasks over few large ones — they dispatch better to agents.
- No task should require reading a conversation transcript; write down every
  decision the implementer needs.
- Mark any task that needs human-only access (credentials, prod, billing).
