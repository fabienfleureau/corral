# Bounded automatic retries for stopped dispatched agents

Status: Accepted

## Context

A dispatched task stays under **In progress** with an `agent stopped` badge when its Omnigent session transitions to `idle`, `done` (`waiting`), or `error` without calling `/api/reports`. Previously, Corral only retried a single startup error (`native_terminal_start_failed`) once, immediately surfaced plain closing messages or errors to the inbox without retrying, and missed three silent-stop cases (`status === "done"`, `lastRunOutcome() === null` after a mid-tool crash, and restarts after an earlier answered question).

## Decision

`CaptureEngine` automatically retries stopped runs on dispatched tasks with no open inbox item before escalating to the inbox, using a bounded per-episode policy configurable via `stoppedRetry` in `~/.config/corral/config.json`:

- **Fatal errors** (authentication `401`/`403`, billing/quota `402` / insufficient balance, unknown model, context length exceeded, or a repeated `native_terminal_start_failed` after the initial retry): **0 retries** — escalate to the inbox immediately.
- **Transient errors and mid-run crashes** (other `error` outcomes, `status === "error"`, or `lastRunOutcome() === null`): up to **2 automatic retries** (default delays `15s`, `60s`), then escalate to the inbox.
- **Silent stops without reporting** (`idle`/`done` with a closing assistant message and no report): up to **1 automatic nudge** (default delay `15s`) reminding the agent to continue or report via `POST /api/reports`, then escalate to the inbox.

`CaptureEngine` also treats `done` as a stopped status, handles `lastRunOutcome() === null` instead of dropping it, cancels any pending retry timer if the session resumes (`working`/`blocked`), finishes, or reports, and resets the episode counter when the human replies (`POST /api/items/:id/reply`) or sends a manual instruction. Retries are recorded in `metrics_events` (`task.stopped_retry`) and `task_events` so budgets survive server restarts.

## Alternatives considered

- **Retry only technical errors/crashes, escalate silent assistant messages immediately:** avoids an extra turn when an agent intentionally addressed the human in plain text, but leaves agents that forgot to call `/api/reports` interrupting the human on the first stop.
- **No automatic retries; fix the three silent-stop gaps and escalate everything directly to the inbox:** simpler, but forces manual intervention for transient API/network blips and rate limits.

## Consequences

- Transient failures and silent stops recover without human intervention while staying strictly bounded per episode and across restarts.
- No dispatched task with a stopped session remains silently stuck under **In progress** without either a scheduled retry or an open inbox item.
- Implementation: [`server/stopped-retry.ts`](../../server/stopped-retry.ts), [`server/capture.ts`](../../server/capture.ts).
