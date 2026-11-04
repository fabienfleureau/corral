// Capture & lifecycle: turn worker events into inbox items and auto-resolve
// them.
//
//  - session blocked on an elicitation -> question item (prompt + choices as
//    quick-reply buttons) — the structured path
//  - session blocked without elicitation data -> question item with a raw
//    output tail — the fallback path
//  - session leaves blocked -> its open question item auto-resolves (only on
//    that transition: an agent-reported question survives the turn ending)
//  - session finished -> linked task marked done, open questions resolve
//  - a `kind=done` report marks the task done and stores its handoff document

import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { WorkerBackend, WorkerElicitation, WorkerEvent } from "./worker.ts";
import { syncTaskPr } from "./pr.ts";
import type { Item } from "./types.ts";

export type Hub = { broadcast: (type: string, data: unknown) => void };

const TAIL_LINES = 40;

export class CaptureEngine {
  private db: Db;
  private backend: WorkerBackend;
  private hub: Hub;
  private cfg: Config | null;

  constructor(db: Db, backend: WorkerBackend, hub: Hub, cfg: Config | null = null) {
    this.db = db;
    this.backend = backend;
    this.hub = hub;
    this.cfg = cfg;
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
    const blocked = e.status === "blocked";
    const wasBlocked = tracked?.last_status === "blocked";
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

    if (blocked) {
      await this.ensureQuestionItem(e, taskId);
    } else if (wasBlocked) {
      this.resolveOpenQuestion(e.address, "auto");
    }
  }

  private async ensureQuestionItem(e: WorkerEvent, taskId: string | null): Promise<Item | null> {
    const existing = this.db.openQuestionItemForTerminal(e.address);
    if (existing) {
      const first = e.elicitations?.[0];
      if (first && existing.elicitation) {
        try {
          const old = JSON.parse(existing.elicitation) as { id?: string };
          if (old.id === first.id) {
            const elicitation = JSON.stringify({ id: first.id, kind: first.kind, field: first.field ?? null, ...(first.persistPattern ? { persistPattern: first.persistPattern } : {}) });
            if (existing.elicitation !== elicitation) {
              this.db.updateItem(existing.id, { elicitation });
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
      elicitation = JSON.stringify({ id: first.id, kind: first.kind, field: first.field ?? null, ...(first.persistPattern ? { persistPattern: first.persistPattern } : {}) });
    } else {
      try {
        body = (await this.backend.read(e.address, TAIL_LINES)) || "(output unavailable)";
      } catch {
        body = "(output unavailable)";
      }
      title = task ? `${task.title} — needs you` : `Agent ${e.address} needs you`;
    }

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
      capture: elicitations.length > 0 ? "elicitation" : "blocked-fallback",
      task_id: taskId,
    });
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

  private async onFinished(e: WorkerEvent): Promise<void> {
    this.resolveOpenQuestion(e.address, "auto");
    const taskId = e.task_id ?? this.db.getTerminal(e.address)?.task_id ?? null;
    if (taskId) {
      const task = this.db.getTask(taskId);
      if (task && (task.status === "dispatched" || task.status === "open")) {
        this.db.updateTask(task.id, { status: "done", exit_code: e.exit_code ?? null });
        this.db.recordMetric("task.finished", task.id, { exit_code: e.exit_code ?? null });
        const updated = this.db.getTask(task.id);
        this.hub.broadcast("task.updated", updated);
        if (updated) {
          // PR discovery is best effort.
          void syncTaskPr(this.db, this.hub, updated, { backend: this.backend, cfg: this.cfg ?? undefined }).catch(() => undefined);
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
    const itemKind: Item["kind"] = isDone ? "pr" : "question";
    const taskId = opts.taskId ?? null;
    const address =
      opts.terminal ??
      (taskId ? this.db.getTask(taskId)?.terminal_address ?? null : null);
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
        this.hub.broadcast("task.updated", this.db.getTask(task.id));
      }
    }

    // A structured question supersedes any pending capture for this terminal
    // (fallback tail or elicitation) — the agent's own framing is authoritative.
    if (address && itemKind === "question") {
      const existing = this.db.openQuestionItemForTerminal(address);
      if (existing) {
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
    }
    // Completion: one PR item per task. Reuse the one the periodic sync may
    // have created; stay unready until syncTaskPr verifies the gate.
    if (itemKind === "pr" && taskId) {
      const existing = this.db
        .listItems({ kind: "pr" })
        .find((i) => i.task_id === taskId && i.status !== "archived");
      if (existing) {
        this.db.updateItem(existing.id, {
          title: opts.title,
          summary: "checking the PR",
          body: opts.body,
          context: context || existing.context,
          source_ref: address ?? existing.source_ref,
          ready: 0,
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
    return item;
  }

  /** Verify the PR gate right after a completion report (best effort). */
  private syncPrSoon(taskId: string): void {
    const task = this.db.getTask(taskId);
    if (!task?.branch) return;
    void syncTaskPr(this.db, this.hub, task, { backend: this.backend, cfg: this.cfg ?? undefined }).catch(() => undefined);
  }
}
