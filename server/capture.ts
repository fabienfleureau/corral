// Capture & lifecycle: turn worker events into inbox items and auto-resolve
// them.
//
//  - session blocked on an elicitation -> question item (prompt + choices as
//    quick-reply buttons) — the structured path
//  - session blocked without elicitation data -> question item with a raw
//    output tail — the fallback path
//  - session leaves blocked -> its captured question auto-resolves, but an
//    agent-reported question posted during the block stays open
//  - session finished -> linked task marked done, open questions resolve
//  - a `kind=done` report marks the task done and stores its handoff document

import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { JiraTransitionGateway } from "./jira-status.ts";
import type { WorkerBackend, WorkerElicitation, WorkerEvent, WorkerRunOutcome, WorkerSession } from "./worker.ts";
import { clearItemHandling, syncTaskPr } from "./pr.ts";
import { cleanupFinishedTask } from "./worktree-cleanup.ts";
import { logTaskEvent, oneLine, promptData } from "./task-events.ts";
import { PlanConflictError, planMarkdown, readSpec } from "./multi-repo.ts";
import {
  STOPPED_STATUSES,
  classifyStoppedRun,
  resolveStoppedRetryConfig,
  stoppedEscalationContent,
  stoppedRetryBudget,
  stoppedRetryDelayMs,
  stoppedRetryPrompt,
  type StoppedCategory,
  type StoppedRetryConfig,
} from "./stopped-retry.ts";
import type { Item, TaskSpec } from "./types.ts";
import { reviewReportedDone } from "./review-outcome.ts";

export type Hub = { broadcast: (type: string, data: unknown) => void };

const TAIL_LINES = 40;
const STOPPED_TEXT_MAX = 6000;
const DEFAULT_RETRY_STALL_MS = 30_000;

export interface CaptureEngineOptions {
  /** Override stopped-run retry policy (takes precedence over cfg.stoppedRetry). */
  stoppedRetry?: Partial<StoppedRetryConfig>;
  /** How long a session may stay stopped after an auto-retry send before another poll treats it as stopped again. */
  retryStallMs?: number;
}

export class CaptureEngine {
  private db: Db;
  private backend: WorkerBackend;
  private hub: Hub;
  private cfg: Config | null;
  /** Jira status sync for PR-stage transitions (null = build one from cfg). */
  private jira: JiraTransitionGateway | null;
  private retryPolicy: StoppedRetryConfig;
  private retryStallMs: number;
  private retrying = new Set<string>();
  /** Sessions that stopped but whose last run could not be read: retried on the next idle poll. */
  private unreadStops = new Set<string>();
  /** Pending delayed auto-retries, keyed by session address. */
  private pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Timestamp when an auto-retry was sent to a session that has not yet transitioned to working. */
  private retrySentAt = new Map<string, number>();
  /** Monotonic metrics_events.id watermark per session after a manual human intervention. */
  private resetAfterId = new Map<string, number>();
  /** Sessions currently being archived (prevents pending retries/events from reviving them). */
  private archiving = new Set<string>();

  constructor(
    db: Db,
    backend: WorkerBackend,
    hub: Hub,
    cfg: Config | null = null,
    jira: JiraTransitionGateway | null = null,
    opts: CaptureEngineOptions = {},
  ) {
    this.db = db;
    this.backend = backend;
    this.hub = hub;
    this.cfg = cfg;
    this.jira = jira;
    this.retryPolicy = resolveStoppedRetryConfig(opts.stoppedRetry ?? cfg?.stoppedRetry);
    this.retryStallMs = opts.retryStallMs ?? DEFAULT_RETRY_STALL_MS;
  }

  /** Cancel any pending retry timer and clear stop-tracking state for this session. */
  cancelStoppedRetries(address: string): void {
    this.cancelPendingRetry(address);
    this.retrySentAt.delete(address);
    this.unreadStops.delete(address);
  }

  /** Suppress retries and cancel pending timers while an archive request is in flight. */
  beginArchiving(address: string): void {
    this.archiving.add(address);
    this.cancelStoppedRetries(address);
  }

  /** Clear the in-flight archive guard after the archive request completes or fails. */
  endArchiving(address: string): void {
    this.archiving.delete(address);
  }

  /** Cancel any pending retry timer and start a fresh retry episode for this session
   *  (called when the human manually replies or sends a new instruction). */
  resetStoppedRetries(address: string): void {
    this.cancelStoppedRetries(address);
    this.resetAfterId.set(address, this.latestMetricId());
  }

  /** Cancel all pending retry timers (for clean shutdown / tests). */
  dispose(): void {
    for (const timer of this.pendingRetries.values()) clearTimeout(timer);
    this.pendingRetries.clear();
  }

  async handleEvent(e: WorkerEvent): Promise<void> {
    try {
      switch (e.type) {
        case "created": {
          // First sight carries the current status: a session already
          // blocked at startup must still produce its question.
          await this.onStatus(e);
          break;
        }
        case "status": {
          await this.onStatus(e);
          break;
        }
        case "finished": {
          await this.onFinished(e);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("corral: capture event error", err);
    }
  }

  private async onStatus(e: WorkerEvent): Promise<void> {
    const tracked = this.db.getTerminal(e.address);
    const taskId = e.task_id ?? tracked?.task_id ?? null;
    if (!tracked && !taskId) return; // not a Corral session
    const task = taskId ? this.db.getTask(taskId) : null;
    const blocked = e.status === "blocked";
    const wasBlocked = tracked?.last_status === "blocked";
    const status = e.status ?? null;
    // A run ended: the PR item the agent was handling goes back to the inbox.
    const runEnded = tracked?.last_status === "working" && (status === "idle" || status === "done" || status === "error");
    // A stopped session started acting again: any snoozed item moves to in progress.
    const runResumed = status === "working" && (tracked?.last_status === "idle" || tracked?.last_status === "done" || tracked?.last_status === "error");
    this.db.upsertTerminal({
      address: e.address,
      task_id: taskId,
      name: tracked?.name ?? null,
      agent: tracked?.agent ?? null,
      last_status: e.status ?? null,
      last_turn: e.turn ?? tracked?.last_turn ?? 0,
      updated_ms: Date.now(),
    });
    if (tracked?.last_status !== (e.status ?? null)) {
      this.hub.broadcast("session.updated", { address: e.address, task_id: taskId, status: e.status ?? null });
    }
    if (task?.status === "archived" || this.archiving.has(e.address)) {
      this.cancelStoppedRetries(e.address);
      if (runEnded && taskId) clearItemHandling(this.db, this.hub, taskId);
      return;
    }

    // A failed lookup must not abort the rest of the handler: the stop below would be lost.
    const retried = ["idle", "done", "error"].includes(e.status ?? "")
      ? await this.retryInitialFailure(e.address, taskId).catch((err) => {
        console.error("corral: initial-failure check failed", err);
        return false;
      })
      : false;
    if (runEnded && taskId) clearItemHandling(this.db, this.hub, taskId);
    if (runResumed) resumeSnoozedItems(this.db, this.hub, { taskId, address: e.address });

    if (blocked) {
      this.cancelPendingRetry(e.address);
      this.retrySentAt.delete(e.address);
      await this.ensureQuestionItem(e, taskId);
    } else {
      if (wasBlocked) this.resolveCapturedBlockedQuestion(e.address);
      // A run ended (a status change into idle/done/error), or first sight of a
      // stopped session whose task nobody has heard about: retry boundedly, then
      // surface to the inbox.
      const stopped = status !== null && STOPPED_STATUSES.has(status);
      if (!stopped) {
        this.unreadStops.delete(e.address);
        this.cancelPendingRetry(e.address);
        this.retrySentAt.delete(e.address);
      }
      const sentAt = this.retrySentAt.get(e.address);
      const stalledAfterRetry = sentAt !== undefined && Date.now() - sentAt >= this.retryStallMs;
      const wasStopped = tracked?.last_status != null && STOPPED_STATUSES.has(tracked.last_status);
      const newlyStopped = e.type === "created"
        ? (!wasStopped && tracked?.last_status != null) || !this.hasDismissedQuestion(e.address)
        : !wasStopped || (status === "error" && tracked?.last_status !== "error");
      const ended = newlyStopped || this.unreadStops.has(e.address) || stalledAfterRetry;
      if (stopped && ended && !retried && taskId) await this.handleStoppedRun(e, taskId);
    }
  }

  /** The agent's turn ended and nothing in the inbox says why: no report, no
   *  question. Without this the task reads "in progress" forever. Bounded
   *  automatic retries absorb transient failures and silent stops (ADR 0016);
   *  once the budget is spent (or on a fatal error), an inbox item hands control
   *  back to the human. Nothing is closed on the agent's behalf. */
  private async handleStoppedRun(e: WorkerEvent, taskId: string): Promise<void> {
    this.unreadStops.delete(e.address);
    if (this.archiving.has(e.address) || !this.awaitingNobody(e.address, taskId) || this.pendingRetries.has(e.address)) return;
    if (typeof this.backend.get === "function") {
      try {
        const live = await this.backend.get(e.address, { strict: true });
        if (live?.state === "finished") return;
        if (live?.status && !STOPPED_STATUSES.has(live.status)) return;
      } catch {
        this.unreadStops.add(e.address);
        return;
      }
    }
    if (this.archiving.has(e.address) || !this.awaitingNobody(e.address, taskId) || this.pendingRetries.has(e.address)) return;
    let outcome: WorkerRunOutcome | null = null;
    if (this.backend.lastRunOutcome) {
      try {
        outcome = await this.backend.lastRunOutcome(e.address);
      } catch {
        this.unreadStops.add(e.address); // the stop is not consumed: look again on the next stopped poll
        return;
      }
    }
    // While the session was being read the agent may have reported, or started a new run.
    if (this.archiving.has(e.address) || !this.awaitingNobody(e.address, taskId) || this.db.getTerminal(e.address)?.last_status !== e.status) return;
    if (this.pendingRetries.has(e.address)) return;

    const initialRetryExhausted = Boolean(
      this.db.stmt("SELECT 1 FROM metrics_events WHERE name = ? AND ref = ? LIMIT 1").get("task.initial_retry", e.address),
    );
    const category = classifyStoppedRun(e.status ?? null, outcome, { initialRetryExhausted });
    const budget = stoppedRetryBudget(this.retryPolicy, category);
    const used = category === "fatal" ? 0 : this.episodeAttempts(e.address, category);

    if (category !== "fatal" && used < budget) {
      const delayMs = stoppedRetryDelayMs(this.retryPolicy, category, used);
      const timer = setTimeout(() => {
        this.pendingRetries.delete(e.address);
        void this.executeStoppedRetry(e, taskId, category, outcome, budget).catch((err) => {
          console.error("corral: stopped-run retry failed", err);
        });
      }, delayMs);
      timer.unref?.();
      this.pendingRetries.set(e.address, timer);
      return;
    }

    await this.escalateStoppedRun(e, taskId, outcome, category, used);
  }

  private async executeStoppedRetry(
    e: WorkerEvent,
    taskId: string,
    category: "error" | "silent",
    outcome: WorkerRunOutcome | null,
    budget: number,
  ): Promise<void> {
    if (this.archiving.has(e.address)) return;
    const currentStatus = this.db.getTerminal(e.address)?.last_status ?? null;
    if (!this.awaitingNobody(e.address, taskId) || !STOPPED_STATUSES.has(currentStatus ?? "")) return;
    if (typeof this.backend.get === "function") {
      let live: WorkerSession | null;
      try {
        live = await this.backend.get(e.address, { strict: true });
      } catch {
        this.unreadStops.add(e.address);
        return;
      }
      if (!live || live.state === "finished") return;
      if (live.status && !STOPPED_STATUSES.has(live.status)) return;
      const statusAfter = this.db.getTerminal(e.address)?.last_status ?? null;
      if (this.archiving.has(e.address) || !this.awaitingNobody(e.address, taskId) || !STOPPED_STATUSES.has(statusAfter ?? "")) return;
    }
    const used = this.episodeAttempts(e.address, category);
    if (used >= budget) {
      await this.escalateStoppedRun(e, taskId, outcome, category, used);
      return;
    }
    const attempt = used + 1;
    const prompt = stoppedRetryPrompt(category, outcome, attempt, budget);
    // Record before sending so an uncertain delivery never exceeds the retry budget.
    this.db.recordMetric("task.stopped_retry", e.address, {
      task_id: taskId,
      category,
      attempt,
      max_attempts: budget,
      status: e.status ?? null,
    });
    this.retrySentAt.set(e.address, Date.now());
    try {
      await this.backend.send(e.address, prompt);
    } catch (err) {
      this.retrySentAt.delete(e.address);
      await this.escalateStoppedRun(e, taskId, outcome, category, attempt, err instanceof Error ? err.message : String(err));
      return;
    }
    const label = category === "silent" ? "nudge" : "retry";
    const reason = outcome?.text ? ` (${oneLine(outcome.text, 80)})` : "";
    logTaskEvent(
      this.db,
      taskId,
      "prompt",
      `Auto-${label} ${attempt}/${budget} after agent stopped${reason}`,
      promptData(prompt, { source: "stopped-retry", category, attempt, max_attempts: budget, session: e.address }),
    );
  }

  private async escalateStoppedRun(
    e: WorkerEvent,
    taskId: string,
    outcome: WorkerRunOutcome | null,
    category: StoppedCategory,
    attemptsUsed: number,
    sendError: string | null = null,
  ): Promise<void> {
    this.retrySentAt.delete(e.address);
    if (this.archiving.has(e.address) || !this.awaitingNobody(e.address, taskId)) return;
    const task = this.db.getTask(taskId);
    const content = stoppedEscalationContent({
      label: task?.title.trim(),
      status: e.status ?? null,
      outcome,
      category,
      attemptsUsed,
      maxTextLen: STOPPED_TEXT_MAX,
      sendError,
    });
    await this.ensureQuestionItem(e, taskId, content);
  }

  private cancelPendingRetry(address: string): void {
    const timer = this.pendingRetries.get(address);
    if (timer) {
      clearTimeout(timer);
      this.pendingRetries.delete(address);
    }
  }

  private latestMetricId(): number {
    const row = this.db.stmt("SELECT COALESCE(MAX(id), 0) AS id FROM metrics_events").get() as { id: number };
    return row.id;
  }

  private lastResetMetricId(address: string): number {
    let since = this.resetAfterId.get(address) ?? 0;
    const rows = this.db
      .stmt("SELECT id, data FROM metrics_events WHERE name = 'item.replied' AND id > ? ORDER BY id DESC LIMIT 50")
      .all(since) as { id: number; data: string | null }[];
    for (const row of rows) {
      if (!row.data) continue;
      try {
        const parsed = JSON.parse(row.data) as { address?: unknown };
        if (parsed.address === address) {
          since = Math.max(since, row.id);
          break;
        }
      } catch { /* ignore malformed metric data */ }
    }
    return since;
  }

  private episodeAttempts(address: string, category: "error" | "silent"): number {
    const sinceId = this.lastResetMetricId(address);
    const rows = this.db
      .stmt("SELECT data FROM metrics_events WHERE name = 'task.stopped_retry' AND ref = ? AND id > ?")
      .all(address, sinceId) as { data: string | null }[];
    let count = 0;
    for (const row of rows) {
      if (!row.data) continue;
      try {
        const parsed = JSON.parse(row.data) as { category?: unknown };
        if (parsed.category === category) count++;
      } catch { /* ignore malformed metric data */ }
    }
    return count;
  }

  /** True when the terminal's latest question item was dismissed or archived without a reply,
   *  so a server restart does not re-surface a stop the human already acknowledged. */
  private hasDismissedQuestion(address: string): boolean {
    const existing = this.db.latestQuestionItemForTerminal(address);
    if (!existing) return false;
    if (existing.status === "open" || existing.status === "archived") return true;
    const replied = this.db
      .stmt("SELECT 1 FROM metrics_events WHERE name = 'item.replied' AND ref = ? LIMIT 1")
      .get(existing.id);
    return !replied;
  }

  /** True while the task is in flight on this session and no open item asks the human anything. */
  private awaitingNobody(address: string, taskId: string): boolean {
    const task = this.db.getTask(taskId);
    if (!task || task.status !== "dispatched" || task.terminal_address !== address) return false;
    return !this.db.hasOpenItemFor(address, taskId);
  }

  private async retryInitialFailure(address: string, taskId: string | null): Promise<boolean> {
    const task = taskId ? this.db.getTask(taskId) : null;
    if (this.archiving.has(address) || !task || task.status !== "dispatched" || task.terminal_address !== address ||
        Date.now() - task.updated_ms > 10 * 60_000 ||
        !this.backend.initialFailurePrompt || this.retrying.has(address) ||
        this.db.stmt("SELECT 1 FROM metrics_events WHERE name = ? AND ref = ? LIMIT 1").get("task.initial_retry", address)) return false;
    this.retrying.add(address);
    try {
      if (typeof this.backend.get === "function") {
        const live = await this.backend.get(address, { strict: true });
        if (live?.state === "finished") return false;
      }
      const prompt = await this.backend.initialFailurePrompt(address);
      const current = this.db.getTask(task.id);
      if (this.archiving.has(address) || !prompt || current?.status !== "dispatched" || current.terminal_address !== address) return false;
      // Claim before sending: an uncertain delivery must never trigger duplicates.
      this.db.recordMetric("task.initial_retry", address, { task_id: task.id });
      await this.backend.send(address, prompt);
      logTaskEvent(this.db, task.id, "prompt", "Initial prompt re-sent (the run failed to start)", promptData(prompt, { source: "retry", session: address }));
      return true;
    } finally {
      this.retrying.delete(address);
    }
  }

  private async ensureQuestionItem(e: WorkerEvent, taskId: string | null, stopped?: { title: string; body: string }): Promise<Item | null> {
    const existing = this.db.openQuestionItemForTerminal(e.address);
    if (existing) {
      const first = e.elicitations?.[0];
      if (first && existing.elicitation) {
        try {
          const old = JSON.parse(existing.elicitation) as { id?: string };
          if (old.id === first.id) {
            const elicitation = JSON.stringify({ id: first.id, kind: first.kind, field: first.field ?? null, ...(first.questions ? { questions: first.questions } : {}), ...(first.persistPattern ? { persistPattern: first.persistPattern } : {}) });
            if (existing.elicitation !== elicitation) {
              this.db.updateItem(existing.id, { elicitation, ...(first.questions ? {
                title: first.prompt.split("\n")[0].slice(0, 120),
                options: first.choices.length ? JSON.stringify(first.choices.slice(0, 8)) : null,
                body: `${existing.body}\n\n---\n\n${first.questions.map((q) => [q.prompt, ...q.choices.map((c) => `- ${c}`)].join("\n")).join("\n\n")}`,
              } : {}) });
              this.hub.broadcast("item.updated", this.db.getItem(existing.id));
            }
          }
        } catch { /* Keep an unrecognized existing item intact. */ }
      }
      return existing;
    }

    const task = taskId ? this.db.getTask(taskId) : null;
    const elicitations: WorkerElicitation[] = e.elicitations ?? [];
    let title: string;
    let summary = "";
    let body: string;
    let options: string | null = null;
    let structured = 0;
    let elicitation: string | null = null;

    if (elicitations.length > 0) {
      structured = 1;
      const first = elicitations[0];
      title = first.prompt.split("\n")[0].slice(0, 120) || (task ? `${task.title} — needs you` : "Agent needs you");
      body = elicitations
        .map((el) => {
          const lines = [`**${el.kind}**: ${el.prompt}`];
          if (el.choices.length > 0) lines.push("", ...el.choices.map((c) => `- ${c}`));
          return lines.join("\n");
        })
        .join("\n\n---\n\n");
      if (first.choices.length > 0) options = JSON.stringify(first.choices.slice(0, 8));
      elicitation = JSON.stringify({ id: first.id, kind: first.kind, field: first.field ?? null, ...(first.questions ? { questions: first.questions } : {}), ...(first.persistPattern ? { persistPattern: first.persistPattern } : {}) });
    } else if (stopped) {
      ({ title, body } = stopped);
    } else {
      try {
        body = (await this.backend.read(e.address, TAIL_LINES)) || "(output unavailable)";
      } catch {
        body = "(output unavailable)";
      }
      title = task ? `${task.title} — needs you` : `Agent ${e.address} needs you`;
    }

    const previous = this.db.questionItemForTerminal(e.address) ?? (taskId ? this.db.openQuestionItemForTask(taskId) : null);
    if (previous) {
      this.db.updateItem(previous.id, {
        status: "open", resolved_ms: null, title, summary, body: `${previous.body}\n\n---\n\n${body}`,
        options, structured, elicitation, source_ref: e.address, task_id: taskId ?? previous.task_id,
      });
      const updated = this.db.getItem(previous.id)!;
      this.hub.broadcast("item.updated", updated);
      return updated;
    }

    const capture = elicitations.length > 0 ? "elicitation" : stopped ? "idle-fallback" : "blocked-fallback";
    const item: Item = {
      id: randomUUID(),
      kind: "question",
      status: "open",
      title,
      summary,
      body,
      context: "",
      options,
      ready: 1,
      source_ref: e.address,
      task_id: taskId,
      structured,
      elicitation,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      resolved_ms: null,
      snooze_until_ms: null,
    };
    this.db.insertItem(item);
    this.db.recordMetric("item.created", item.id, {
      kind: "question",
      capture,
      task_id: taskId,
    });
    if (taskId) {
      logTaskEvent(this.db, taskId, "question", `Agent asked: ${oneLine(title, 110)}`, {
        item_id: item.id,
        capture,
      });
    }
    this.hub.broadcast("item.created", item);
    return item;
  }

  /** Leaving blocked closes the capture that caused it, not a question the
   *  agent reported after the block began. A report reuses the same item and
   *  clears its elicitation, so that is the distinction that survives.
   *  A fallback capture has no elicitation and is still structured=0. */
  private resolveCapturedBlockedQuestion(address: string): void {
    const item = this.db.openQuestionItemForTerminal(address);
    if (item && (!item.elicitation && item.structured === 1)) return;
    this.resolveOpenQuestion(address, "auto");
  }

  resolveOpenQuestion(address: string, how: "auto" | "manual"): void {
    this.resolveOpenQuestions({ address }, how);
  }

  private resolveOpenQuestions(opts: { address?: string | null; taskId?: string | null }, how: "auto" | "manual"): void {
    const now = Date.now();
    for (const item of this.db.openQuestionItemsFor(opts)) {
      this.db.updateItem(item.id, { status: "resolved", resolved_ms: now, snooze_until_ms: null });
      this.db.recordMetric("item.resolved", item.id, { how });
      this.hub.broadcast("item.updated", this.db.getItem(item.id));
    }
  }

  private async onFinished(e: WorkerEvent): Promise<void> {
    this.cancelPendingRetry(e.address);
    this.retrySentAt.delete(e.address);
    this.unreadStops.delete(e.address);
    const taskId = e.task_id ?? this.db.getTerminal(e.address)?.task_id ?? null;
    const task = taskId ? this.db.getTask(taskId) : null;
    this.resolveOpenQuestions({
      address: e.address,
      taskId: task && task.terminal_address === e.address ? task.id : null,
    }, "auto");
    if (taskId) {
      // The session is gone: whatever it was handling is the human's again.
      clearItemHandling(this.db, this.hub, taskId);
      if (task && (task.status === "dispatched" || task.status === "open")) {
        this.db.updateTask(task.id, { status: "done", exit_code: e.exit_code ?? null });
        this.db.recordMetric("task.finished", task.id, { exit_code: e.exit_code ?? null });
        logTaskEvent(this.db, task.id, "session", "Agent session finished", {
          exit_code: e.exit_code ?? null,
          session: e.address,
        });
        const updated = this.db.getTask(task.id);
        this.hub.broadcast("task.updated", updated);
        if (updated) {
          // PR discovery is best effort. Release the worktree only after it
          // has had a chance to attach an open PR item to the task.
          void syncTaskPr(this.db, this.hub, updated, { backend: this.backend, cfg: this.cfg ?? undefined, jira: this.jira })
            .catch(() => undefined)
            .finally(() => void cleanupFinishedTask(this.db, this.backend, task.id, { hub: this.hub, reason: "session-finished" }));
        }
      }
    }
  }

  /** Called from POST /api/reports: a structured report from an agent.
   *  kind "question" -> question item; kind "done"/"pr" -> pr item + task
   *  completion (with its handoff document stored for follow-up sessions). */
  async createStructuredQuestion(opts: {
    kind?: string;
    taskId?: string | null;
    terminal?: string | null;
    title: string;
    body: string;
    options?: string[];
  }): Promise<Item> {
    const isDone = opts.kind === "done" || opts.kind === "pr";
    const taskId = opts.taskId ?? null;
    // A task without a PR of its own reports into the inbox as information.
    const taskKind = taskId ? this.db.getTask(taskId)?.kind : undefined;
    const noPr = taskKind === "review" || taskKind === "spec" || taskKind === "analysis" || taskKind === "ops" || taskKind === "grill" || (taskKind === "grill-docs" && !/\bPR:\s*https?:\/\/[^\s)]+\/(?:pull|merge_requests)\/\d+/i.test(opts.body));
    const itemKind: Item["kind"] = isDone ? (noPr ? "digest" : "pr") : "question";
    const address =
      opts.terminal ??
      (taskId ? this.db.getTask(taskId)?.terminal_address ?? null : null);
    if (address) {
      this.cancelPendingRetry(address);
      this.retrySentAt.delete(address);
    }
    let context = "";
    if (address) {
      try {
        context = (await this.backend.read(address, 60)) ?? "";
      } catch {
        context = "";
      }
    }
    const optionsJson = opts.options?.length ? JSON.stringify(opts.options) : null;

    // Completion: the task is done, and its handoff document lives on for any
    // fresh session that continues the work (PR loop).
    if (isDone && taskId) {
      const task = this.db.getTask(taskId);
      if (task) {
        const handoff = /##\s*handoff/i.test(opts.body)
          ? opts.body.split(/##\s*handoff/i).slice(1).join("## Handoff").trim()
          : opts.body.trim();
        // A merged PR already archived the task: keep it archived.
        this.db.updateTask(task.id, task.status === "archived" ? { handoff } : { status: "done", handoff });
        reviewReportedDone(this.db, this.hub, task.id);
        this.resolveOpenQuestions({
          taskId: task.id,
          address: address && address === task.terminal_address ? address : null,
        }, "auto");
        logTaskEvent(this.db, task.id, "session", `Agent reported done: ${oneLine(opts.title, 100)}`, {
          report: opts.kind ?? "done",
          item_kind: itemKind,
        });
        this.hub.broadcast("task.updated", this.db.getTask(task.id));
      }
    }

    // A structured question supersedes any pending capture for this terminal
    // or open question for this task — the agent's own framing is authoritative.
    if (itemKind === "question") {
      const existing = (address ? this.db.questionItemForTerminal(address) : null)
        ?? (taskId ? this.db.openQuestionItemForTask(taskId) : null);
      if (existing) {
        this.db.updateItem(existing.id, {
          title: opts.title,
          summary: opts.body,
          body: existing.status === "resolved" ? `${existing.body}\n\n---\n\n${opts.body}` : opts.body,
          status: "open",
          resolved_ms: null,
          elicitation: null,
          context: context || existing.body,
          options: optionsJson,
          source_ref: address ?? existing.source_ref,
          task_id: taskId ?? existing.task_id,
          structured: 1,
        });
        this.db.recordMetric("item.structured_report", existing.id, { task_id: taskId });
        const updated = this.db.getItem(existing.id);
        this.hub.broadcast("item.updated", updated);
        return updated!;
      }
    }
    // Completion: one open digest per task while unacknowledged.
    if (itemKind === "digest" && taskId) {
      const existing = this.db.findOpenItemForTask(taskId, "digest");
      if (existing) {
        this.db.updateItem(existing.id, {
          title: opts.title,
          summary: opts.body,
          body: opts.body,
          context: context || existing.context,
          options: optionsJson,
          source_ref: address ?? existing.source_ref,
          structured: 1,
        });
        this.db.recordMetric("item.structured_report", existing.id, { task_id: taskId, kind: "digest" });
        const updated = this.db.getItem(existing.id)!;
        this.hub.broadcast("item.updated", updated);
        if (isDone) void cleanupFinishedTask(this.db, this.backend, taskId, { hub: this.hub, reason: "done-report" });
        return updated;
      }
    }
    // Completion: one PR item per task. Reuse the one the periodic sync may
    // have created; stay unready until syncTaskPr verifies the gate.
    if (itemKind === "pr" && taskId) {
      const existing = this.db.findPrItemForTask(taskId);
      if (existing) {
        this.db.updateItem(existing.id, {
          title: opts.title,
          summary: "checking the PR",
          body: opts.body,
          context: context || existing.context,
          source_ref: address ?? existing.source_ref,
          ready: 0,
          handling: 0,
          status: "open",
          resolved_ms: null,
        });
        this.db.recordMetric("item.structured_report", existing.id, { task_id: taskId, kind: "pr" });
        const updated = this.db.getItem(existing.id)!;
        this.hub.broadcast("item.updated", updated);
        this.syncPrSoon(taskId);
        return updated;
      }
    }
    const item: Item = {
      id: randomUUID(),
      kind: itemKind,
      status: "open",
      title: opts.title,
      summary: itemKind === "pr" ? "checking the PR" : opts.body,
      body: opts.body,
      context,
      options: optionsJson,
      ready: itemKind === "pr" ? 0 : 1,
      handling: 0,
      source_ref: address,
      task_id: taskId,
      structured: 1,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      resolved_ms: null,
      snooze_until_ms: null,
    };
    this.db.insertItem(item);
    this.db.recordMetric("item.created", item.id, { kind: itemKind, capture: "structured", task_id: taskId });
    this.hub.broadcast("item.created", item);
    if (itemKind === "pr" && taskId) this.syncPrSoon(taskId);
    if (isDone && taskId) void cleanupFinishedTask(this.db, this.backend, taskId, { hub: this.hub, reason: "done-report" });
    return item;
  }

  /** Called from POST /api/reports with kind "plan": a spec task's contract and
   *  proposed sub-tasks (already validated). Appends an immutable revision row,
   *  keeps `tasks.spec` synced to the latest revision, and creates or refreshes
   *  the single open plan item with `handling = 0`. */
  async createPlan(taskId: string, title: string, spec: TaskSpec): Promise<Item> {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("task not found");
    if (task.terminal_address) {
      this.cancelPendingRetry(task.terminal_address);
      this.retrySentAt.delete(task.terminal_address);
    }
    const prevSpec = readSpec(task);
    if (prevSpec?.children?.length) {
      throw new PlanConflictError("this plan was already approved", {
        currentRevisionId: prevSpec.revision_id ?? null,
        currentVersion: prevSpec.version ?? null,
      });
    }
    const latest = this.db.getLatestPlanRevision(taskId);
    const version = (latest?.version ?? prevSpec?.version ?? 0) + 1;
    const revisionId = randomUUID();
    const now = Date.now();
    const body = planMarkdown(spec);
    this.db.insertPlanRevision({
      id: revisionId,
      task_id: taskId,
      version,
      title,
      contract: spec.contract,
      subtasks: spec.subtasks,
      markdown: body,
      created_ms: now,
    });
    const storedSpec: TaskSpec = {
      contract: spec.contract,
      subtasks: spec.subtasks,
      revision_id: revisionId,
      version,
    };
    this.db.updateTask(taskId, { spec: JSON.stringify(storedSpec) });
    logTaskEvent(this.db, taskId, "session", `Agent proposed plan v${version}: ${spec.subtasks.length} sub-tasks`, {
      revision_id: revisionId,
      version,
      repos: spec.subtasks.map((s) => s.repo),
    });
    const updatedTask = this.db.getTask(taskId);
    if (updatedTask) this.hub.broadcast("task.updated", updatedTask);
    const existing = this.db.findOpenItemForTask(taskId, "plan");
    if (existing) {
      this.db.updateItem(existing.id, {
        title,
        summary: body,
        body,
        handling: 0,
        snooze_until_ms: null,
        source_ref: existing.source_ref ?? task.terminal_address,
        updated_ms: now,
      });
      const updated = this.db.getItem(existing.id)!;
      this.hub.broadcast("item.updated", updated);
      return updated;
    }
    const item: Item = {
      id: randomUUID(),
      kind: "plan",
      status: "open",
      title,
      summary: body,
      body,
      context: "",
      options: null,
      ready: 1,
      handling: 0,
      source_ref: task.terminal_address,
      task_id: taskId,
      structured: 1,
      created_ms: now,
      updated_ms: now,
      resolved_ms: null,
      snooze_until_ms: null,
    };
    this.db.insertItem(item);
    this.db.recordMetric("item.created", item.id, { kind: "plan", capture: "structured", task_id: taskId });
    this.hub.broadcast("item.created", item);
    return item;
  }

  /** Verify the PR gate right after a completion report (best effort). */
  private syncPrSoon(taskId: string): void {
    const task = this.db.getTask(taskId);
    if (!task) return;
    void syncTaskPr(this.db, this.hub, task, { backend: this.backend, cfg: this.cfg ?? undefined, jira: this.jira })
      .catch(() => undefined)
      .finally(() => void cleanupFinishedTask(this.db, this.backend, taskId, { hub: this.hub, reason: "done-report" }));
  }
}

/** Move any snoozed open items for a task or session into "In progress" once
 *  the session is acting again: PR items enter the agent-handling phase, and
 *  other items resolve (reopening a done task so it surfaces under In progress). */
export function resumeSnoozedItems(
  db: Db,
  hub: Hub,
  target: { taskId?: string | null; address?: string | null },
  now = Date.now(),
): Item[] {
  const { taskId = null, address = null } = target;
  if (!taskId && !address) return [];
  const snoozed = db.listSnoozedOpenItemsFor({ taskId, address, now });
  if (snoozed.length === 0) return [];
  const updated: Item[] = [];
  let reopenTaskId: string | null = null;
  for (const item of snoozed) {
    if (item.kind === "pr") {
      db.updateItem(item.id, { handling: 1, snooze_until_ms: null });
    } else {
      db.updateItem(item.id, { status: "resolved", resolved_ms: now, snooze_until_ms: null });
      if (item.task_id) reopenTaskId ??= item.task_id;
    }
    const next = db.getItem(item.id);
    if (next) {
      hub.broadcast("item.updated", next);
      updated.push(next);
    }
  }
  const taskToReopen = reopenTaskId ? db.getTask(reopenTaskId) : null;
  if (taskToReopen && taskToReopen.status === "done") {
    db.updateTask(taskToReopen.id, { status: "dispatched" });
    hub.broadcast("task.updated", db.getTask(taskToReopen.id));
  }
  return updated;
}
