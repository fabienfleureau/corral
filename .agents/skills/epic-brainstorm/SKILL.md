---
name: epic-brainstorm
description: Turn a brainstorming on a complex, multi-task or multi-repository piece of work into a Jira epic that Corral can import (design in the epic, one ticket per task, repo and preconditions in each ticket, "blocked by" links). Use when planning work that spans several tickets or repos, or when asked to prepare an epic for Corral.
---

# Brainstorm into a Corral epic

Corral imports a Jira epic and runs its tickets in dependency order. It reads a few
conventions; follow them so the import needs no rework. Brainstorm first (ask one
question at a time, settle the design), then write the epic as below.

## What to produce

**1. The epic.** Its description is the design, v1:

- **Goal**: what changes and why, in 2-3 sentences.
- **Design**: the decisions. For work across repositories, the contract between them:
  every API, event, schema or config key that crosses a repo, with its owner, its
  consumers and the order of delivery.
- **Out of scope**: what this epic does not do.

**2. One ticket per task**, child of the epic. A task is one change in one repository,
small enough for one PR. Description:

```
Repo: <name of the repository as registered in Corral>

## Objectif
<what to do, in the terms of the design>

## Critères d'acceptation
- <observable result>

## Préconditions
- <state of the world this work needs that no ticket link can express>
```

- `Repo:` names exactly one repository. Corral reads this line to pick the repo; keep
  it on its own line, in this form.
- `Préconditions` lists only what a link cannot say, such as "library X 2.0 is
  published" or "the staging database has the new column". Each line must be
  checkable by reading code, a registry or a pipeline. Leave the section out when
  there is none. The agent verifies them before it starts and stops if one fails.

**3. Dependencies** as Jira links of type "Blocks": B "is blocked by" A when B cannot
start before A's PR is ready. Keep the graph acyclic. A task that only needs A to be
*released* (not just reviewed) gets that as a Préconditions line, not a link.

## Rules

- Tickets are descriptions of work, not instructions to the agent about its tools or
  rules. Keep it to the task.
- Never write or edit text between `[corral:begin:...]` and `[corral:end:...]`
  markers in a description: those blocks belong to Corral.
- Do not put the design in each ticket; the epic holds it and Corral gives it to every
  task. A ticket quotes only the part that matters to it.
- Show the epic and the ticket list to the human before creating anything in Jira.
  Create them with the Jira tool available in the session; if there is none, print
  them ready to paste. Then tell the human the epic key to import in Corral (Epics page).
