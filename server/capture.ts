// Capture & lifecycle: turn herdr events into inbox items and auto-resolve them.
//
//  - agent goes `blocked`  -> question item (fallback capture; structured reports
//    coming through POST /api/reports take precedence)
//  - agent leaves `blocked` -> its open question item auto-resolves (you answered)
//  - agent terminal finishes -> linked task marked done, open questions resolve
//  - a periodic reconcile() catches anything the stream missed.

import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import type { HerdrClient } from "./herdr.ts";
import type { HcEvent, HcTerminal, Item } from "./types.ts";

export type Hub = { broadcast: (type: string, data: unknown) => void };

const TAIL_LINES = 40;

function statusState(t: { status?: unknown }): string | null {
  const s = t?.status;
  if (!s) return null;
  if (typeof s === "string") return s;
  if (typeof s === "object" && "state" in s && typeof (s as { state?: unknown }).state === "string") {
    return (s as { state: string }).state;
  }
  return null;
}

export class CaptureEngine {
  private lastState = new Map<string, string | null>();
  private db: Db;
  private herdr: HerdrClient;
  private hub: Hub;

  constructor(db: Db, herdr: HerdrClient, hub: Hub) {
    this.db = db;
    this.herdr = herdr;
    this.hub = hub;
  }

  async handleEvent(e: HcEvent): Promise<void> {
    try {
      switch (e.type) {
        case "created":
        case "labels":
        case "restarted": {
          const labels = (e.data.labels ?? {}) as Record<string, string>;
          const taskId = labels["corral.task"];
          if (taskId) {
            this.db.upsertTerminal({
              address: e.terminal,
              task_id: taskId,
              name: (e.data.name as string) ?? null,
              agent: labels["corral.target"] ?? null,
              last_status: null,
              last_turn: Number(e.data.turn ?? 0),
              updated_ms: Date.now(),
            });
          }
          break;
        }
        case "status": {
          await this.onStatusChange(e.terminal, e.data);
          break;
        }
        case "finished": {
          await this.onFinished(e.terminal, Number(e.data.exit_code ?? -1), (e.data.reason as string) ?? null);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("corral: capture event error", err);
    }
  }

  private async onStatusChange(address: string, data: Record<string, unknown>): Promise<void> {
    const tracked = this.db.getTerminal(address);
    if (!tracked) return;
    const state = statusState(data as { status?: unknown });
    const prev = this.lastState.get(address) ?? tracked.last_status ?? null;
    this.lastState.set(address, state);
    this.db.upsertTerminal({ ...tracked, last_status: state, updated_ms: Date.now() });

    if (state === "blocked" && prev !== "blocked") {
      await this.ensureQuestionItem(address, tracked.task_id);
    } else if (state && state !== "blocked" && prev === "blocked") {
      this.resolveOpenQuestion(address, "auto");
    }
  }

  private async ensureQuestionItem(address: string, taskId: string | null): Promise<Item | null> {
    const existing = this.db.openQuestionItemForTerminal(address);
    if (existing) return existing;
    let tail = "";
    try {
      const read = await this.herdr.readTerminal(address, TAIL_LINES);
      tail = read.text;
    } catch {
      tail = "(output unavailable)";
    }
    const task = taskId ? this.db.getTask(taskId) : null;
    const item: Item = {
      id: randomUUID(),
      kind: "question",
      status: "open",
      title: task ? `${task.title} — needs you` : `Agent ${address} needs you`,
      summary: "",
      body: tail,
      context: "",
      options: null,
      source_ref: address,
      task_id: taskId,
      structured: 0,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      resolved_ms: null,
      snooze_until_ms: null,
    };
    this.db.insertItem(item);
    this.db.recordMetric("item.created", item.id, { kind: "question", capture: "blocked-fallback", task_id: taskId });
    this.hub.broadcast("item.created", item);
    return item;
  }

  resolveOpenQuestion(address: string, how: "auto" | "manual"): void {
    const item = this.db.openQuestionItemForTerminal(address);
    if (!item) return;
    this.db.updateItem(item.id, { status: "resolved", resolved_ms: Date.now() });
    this.db.recordMetric("item.resolved", item.id, { how });
    this.hub.broadcast("item.updated", this.db.getItem(item.id));
  }

  private async onFinished(address: string, exitCode: number, reason: string | null): Promise<void> {
    const tracked = this.db.getTerminal(address);
    this.resolveOpenQuestion(address, "auto");
    if (tracked?.task_id) {
      const task = this.db.getTask(tracked.task_id);
      if (task && (task.status === "dispatched" || task.status === "open")) {
        this.db.updateTask(task.id, { status: "done", exit_code: exitCode });
        this.db.recordMetric("task.finished", task.id, { exit_code: exitCode, reason });
        this.hub.broadcast("task.updated", this.db.getTask(task.id));
      }
    }
    this.lastState.delete(address);
  }

  /** Called from POST /api/reports: a structured report from an agent.
   *  kind "question" -> question item; kind "done"/"pr" -> pr item (the link
   *  to review). Completion reports supersede nothing — every PR is its own item. */
  async createStructuredQuestion(opts: {
    kind?: string;
    taskId?: string | null;
    terminal?: string | null;
    title: string;
    body: string;
    options?: string[];
  }): Promise<Item> {
    const itemKind: Item["kind"] = opts.kind === "done" || opts.kind === "pr" ? "pr" : "question";
    const taskId = opts.taskId ?? null;
    const address =
      opts.terminal ??
      (taskId ? this.db.getTask(taskId)?.terminal_address ?? null : null);
    let context = "";
    if (address) {
      try {
        context = (await this.herdr.readTerminal(address, 60)).text;
      } catch {
        context = "";
      }
    }
    const optionsJson = opts.options?.length ? JSON.stringify(opts.options) : null;
    // A structured question supersedes a pending fallback capture for this
    // terminal. Completion ("done"/"pr") reports always create their own item.
    if (address && itemKind === "question") {
      const existing = this.db.openQuestionItemForTerminal(address);
      if (existing && existing.structured === 0) {
        this.db.updateItem(existing.id, {
          title: opts.title,
          summary: opts.body,
          body: opts.body,
          context: context || existing.body,
          options: optionsJson,
          task_id: taskId ?? existing.task_id,
          structured: 1,
        });
        this.db.recordMetric("item.structured_report", existing.id, { task_id: taskId });
        const updated = this.db.getItem(existing.id);
        this.hub.broadcast("item.updated", updated);
        return updated!;
      }
      if (existing) return existing;
    }
    const item: Item = {
      id: randomUUID(),
      kind: itemKind,
      status: "open",
      title: opts.title,
      summary: opts.body,
      body: opts.body,
      context,
      options: optionsJson,
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
    return item;
  }

  /** Periodic safety net: re-read tracked terminals and reconcile their state. */
  async reconcile(): Promise<void> {
    let live: HcTerminal[] = [];
    try {
      const res = await this.herdr.listTerminals(true);
      live = res.terminals ?? [];
    } catch {
      return; // core unreachable; the stream will reconnect
    }
    const seen = new Set<string>();
    for (const t of live) {
      seen.add(t.address);
      const tracked = this.db.getTerminal(t.address);
      if (!tracked) continue;
      const state = statusState(t);
      const prev = this.lastState.get(t.address) ?? tracked.last_status ?? null;
      if (state !== prev) {
        this.lastState.set(t.address, state);
        this.db.upsertTerminal({ ...tracked, last_status: state, updated_ms: Date.now() });
        if (state === "blocked") await this.ensureQuestionItem(t.address, tracked.task_id);
        else if (state && prev === "blocked") this.resolveOpenQuestion(t.address, "auto");
      }
      if (t.state === "finished") {
        await this.onFinished(t.address, Number(t.exit_code ?? -1), t.reason);
      }
    }
  }
}
