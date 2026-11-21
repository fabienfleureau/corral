# What Corral can learn from Plannotator

Start with **annotated revisions for multi-repo plans**. Corral already creates child tasks from an approved plan. Give the reviewer a way to correct the contract in place, compare the revised version, and approve the exact version they read.

## What Plannotator does

Plannotator is a local browser tool for reviewing agent output. For a plan, the reviewer selects text, collects comments, and sends them back together or approves the plan. The next version can be compared with earlier submissions. The source implements line-level comparison with a word-level pass for some changed blocks. [Plan review](https://docs.plannotator.ai/open-source/workflows/plan-review) · [Diff implementation](https://github.com/backnotprop/plannotator/blob/main/packages/ui/utils/planDiffEngine.ts)

The inbox already overlaps with Corral. It gathers questions and deliverables from multiple agents and routes feedback back to the origin session. It also keeps copies of submitted files and marks when they have changed. Guided code reviews group the real diff by intent and let the reviewer track which sections they have read. [Inbox](https://plannotator.ai/docs/reference/inbox/) · [Guided review design](https://github.com/backnotprop/plannotator/blob/main/adr/decisions/006-guided-review-first-class-feature-20260702-192821.md)

## Ranked ideas for Corral

### 1. Annotate and revise a multi-repo plan

Corral renders the contract and subtasks in the inbox. A new submission refreshes the open plan item in place, and approval reads the current plan by task ID. The selection toolbar can already turn an excerpt into a new task. [Inbox actions](../web/src/pages/Inbox.tsx) · [Selection toolbar](../web/src/SelectionToTask.tsx) · [Plan capture](../server/capture.ts) · [Approval](../server/multi-repo.ts)

Add **Comment** alongside **New task** on plan text. Keep a draft containing the exact quote, section and revision for each comment, then send all comments in one **Request changes** reply through the existing worker seam. For example, a reviewer could mark an API contract and ask that retries be defined before spelling out each repo's work. The agent returns a new revision, and the reviewer opens **Changes since last version** before deciding.

Start with a plain Markdown diff and a small revision history. Approval should carry the revision ID and reject a stale approval if a new plan arrived during review. Keep child creation tied to approval and use the existing launch actions for dispatch. A useful acceptance case is two tabs reviewing v1 and v2: feedback in the first tab stays attached to v1, and only approval of the current v2 can create children.

### 2. Add a short review guide to ready PRs

Start with ordered Markdown sections in the PR description for changes that span several concerns. Each section says what to inspect, why it matters, and links to the corresponding diff. Use Corral's existing PR description and readiness pipeline. If the guide later gets a structured inbox view, attach it to the head SHA and mark it stale after a push. A dedicated diff viewer would add maintenance across GitHub and GitLab. [Corral PR loop](product-guide.md) · [Plannotator guide snapshots](https://plannotator.ai/docs/reference/portable-guides/)

### 3. Attach reviewable deliverables to inbox reports

The existing attachments run from the user to the agent at dispatch. Add the reverse direction for explicit report attachments, starting with bounded Markdown and PNG screenshots. Store a copy with the report so the reviewer can still see the submitted version after a worktree changes or disappears. For UI work, this puts before and after screenshots beside the agent's explanation. [Corral attachments API](../API.md) · [Plannotator inbox](https://plannotator.ai/docs/reference/inbox/)

### 4. Turn repeated review feedback into suggested checks

Corral already analyzes task and PR activity on the Improve page. Add a report that groups recurring human review feedback by repository, links to representative threads, and drafts a checklist entry for the human to accept or dismiss. An accepted entry could feed an existing pre-PR reviewer. This gives the reviewer a way to verify which feedback justified the rule. [Corral self-improvement](product-guide.md) · [Plannotator code review](https://plannotator.ai/code-review)

The first slice can stay within Corral's inbox, plan reports and worker interface. Plannotator's harness hooks are useful for standalone plan capture. Corral already knows which session owns the task and can use that association to deliver feedback through omnigent. [Corral architecture](architecture.md) · [Plannotator harness integration](https://github.com/backnotprop/plannotator)
