// Scheduled analysis and cleanup of orphaned Corral-owned worker sessions.
// Identifies why Corral-owned sessions lingered (terminal tasks, finished KPI
// or epic-agent cycles, superseded/reopened tasks, missing tasks, orphaned
// sub-agents, or unlinked Corral sessions) and cleans them up safely without
// touching external user sessions, active dispatched tasks, or open-PR tasks.

import { randomUUID } from "node:crypto";
import type {
  SessionCleanupAction,
  SessionCleanupConfig,
  SessionCleanupItem,
  SessionCleanupReason,
  SessionCleanupReport,
  SessionCleanupStatus,
} from "../shared/session-cleanup.ts";
import { DEFAULT_SESSION_CLEANUP } from "./config.ts";
import type { Db } from "./db.ts";
import type { Hub } from "./capture.ts";
import { mapLimit } from "./exec.ts";
import { taskLabel, type Task } from "./types.ts";
import type { WorkerBackend, WorkerSession } from "./worker.ts";
import { canCleanup, cleanupFinishedTask } from "./worktree-cleanup.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveSessionCleanupConfig(partial?: Partial<SessionCleanupConfig>): SessionCleanupConfig {
  return {
    enabled: typeof partial?.enabled === "boolean" ? partial.enabled : DEFAULT_SESSION_CLEANUP.enabled,
    intervalMinutes: positiveNumber(partial?.intervalMinutes, DEFAULT_SESSION_CLEANUP.intervalMinutes),
    graceMinutes: positiveNumber(partial?.graceMinutes, DEFAULT_SESSION_CLEANUP.graceMinutes),
    staleDispatchedHours: positiveNumber(partial?.staleDispatchedHours, DEFAULT_SESSION_CLEANUP.staleDispatchedHours),
  };
}

interface CandidateOrphan {
  session: WorkerSession;
  task: Task | null;
  taskId: string | null;
  reason: Exclude<SessionCleanupReason, "stale_dispatched">;
  detail: string;
}

export interface SessionCleanupRunnerOptions {
  hub?: Pick<Hub, "broadcast">;
  config?: Partial<SessionCleanupConfig>;
  clock?: () => number;
}

export class SessionCleanupRunner {
  private db: Db;
  private backend: WorkerBackend;
  private hub?: Pick<Hub, "broadcast">;
  private cfg: SessionCleanupConfig;
  private clock: () => number;
  private inFlight: Promise<SessionCleanupReport> | null = null;

  constructor(db: Db, backend: WorkerBackend, opts: SessionCleanupRunnerOptions = {}) {
    this.db = db;
    this.backend = backend;
    this.hub = opts.hub;
    this.cfg = resolveSessionCleanupConfig(opts.config);
    this.clock = opts.clock ?? (() => Date.now());
  }

  config(): SessionCleanupConfig {
    return { ...this.cfg };
  }

  status(): SessionCleanupStatus {
    const history = this.db.listSessionCleanupRuns(20);
    return {
      config: this.config(),
      running: this.inFlight !== null,
      lastRun: history[0] ?? null,
      history,
    };
  }

  run(opts: { dryRun?: boolean; trigger?: "scheduled" | "manual" } = {}): Promise<SessionCleanupReport> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.perform(opts).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async perform(opts: { dryRun?: boolean; trigger?: "scheduled" | "manual" }): Promise<SessionCleanupReport> {
    const dryRun = opts.dryRun === true;
    const trigger = opts.trigger ?? "manual";
    const now = this.clock();
    const graceMs = this.cfg.graceMinutes * MINUTE_MS;
    const staleDispatchedMs = this.cfg.staleDispatchedHours * HOUR_MS;

    const allSessions = await this.backend.list();
    const liveSessions = allSessions.filter((s) => s.state !== "finished");

    const tasks = this.db.listTasks();
    const tasksById = new Map(tasks.map((t) => [t.id, t]));
    const tasksByAddress = new Map<string, Task>();
    for (const t of tasks) {
      if (t.terminal_address) tasksByAddress.set(t.terminal_address, t);
    }
    const terminalsByAddress = new Map(this.db.listTerminals().map((t) => [t.address, t]));
    const openItemTaskIds = this.db.listOpenItemTaskIds();
    const openPrTaskIds = this.db.listOpenPrTaskIds();

    const kpiRows = this.db.listKpiMonitorSessions();
    const kpiByAddress = new Map<string, typeof kpiRows[number]>();
    const activeKpiAddresses = new Set<string>();
    const activeKpiNames = new Set<string>();
    for (const k of kpiRows) {
      if (k.address) kpiByAddress.set(k.address, k);
      if (k.run_name) {
        activeKpiNames.add(k.run_name);
        if (k.address) activeKpiAddresses.add(k.address);
      }
    }

    const epicRows = this.db.listEpicAgentSessions();
    const epicByAddress = new Map<string, typeof epicRows[number]>();
    const activeEpicAddresses = new Set<string>();
    const activeEpicNames = new Set<string>();
    for (const e of epicRows) {
      if (e.address) epicByAddress.set(e.address, e);
      if (e.run_name) {
        activeEpicNames.add(e.run_name);
        if (e.address) activeEpicAddresses.add(e.address);
      }
    }

    // Step 1: Identify Corral-owned live sessions (iteratively propagating parent ownership).
    const corralOwned = new Set<string>();
    for (const s of liveSessions) {
      const hasCorralLabel = Boolean(s.task_id) || Boolean(s.harness);
      const inDb =
        tasksByAddress.has(s.address) ||
        terminalsByAddress.has(s.address) ||
        kpiByAddress.has(s.address) ||
        epicByAddress.has(s.address);
      const matchesActiveCycleName = Boolean(
        s.name && (activeKpiNames.has(s.name) || activeEpicNames.has(s.name)),
      );
      if (hasCorralLabel || inDb || matchesActiveCycleName) {
        corralOwned.add(s.address);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of liveSessions) {
        if (!corralOwned.has(s.address) && s.parent && corralOwned.has(s.parent)) {
          corralOwned.add(s.address);
          changed = true;
        }
      }
    }

    // Step 2: Classify Corral-owned sessions (first pass: non-child or direct task/KPI/epic).
    const activeSessions = new Set<string>();
    const deferredChildren: WorkerSession[] = [];
    const orphans: CandidateOrphan[] = [];
    const warnings: SessionCleanupItem[] = [];

    for (const s of liveSessions) {
      if (!corralOwned.has(s.address)) continue;

      const taskId =
        s.task_id ??
        terminalsByAddress.get(s.address)?.task_id ??
        tasksByAddress.get(s.address)?.id ??
        null;

      const isKpi =
        activeKpiAddresses.has(s.address) ||
        (s.name ? activeKpiNames.has(s.name) : false) ||
        kpiByAddress.has(s.address) ||
        (!taskId && Boolean(s.name?.startsWith("KPI: ")));

      if (isKpi) {
        const isActive =
          activeKpiAddresses.has(s.address) ||
          Boolean(s.name && activeKpiNames.has(s.name));
        if (isActive || (now - s.created_ms < graceMs && s.status === "working")) {
          activeSessions.add(s.address);
        } else {
          orphans.push({
            session: s,
            task: null,
            taskId: null,
            reason: "finished_kpi",
            detail: "KPI cycle finished without archiving its session",
          });
        }
        continue;
      }

      const isEpic =
        activeEpicAddresses.has(s.address) ||
        (s.name ? activeEpicNames.has(s.name) : false) ||
        epicByAddress.has(s.address) ||
        (!taskId && Boolean(s.name?.startsWith("Epic: ")));

      if (isEpic) {
        const isActive =
          activeEpicAddresses.has(s.address) ||
          Boolean(s.name && activeEpicNames.has(s.name));
        if (isActive || (now - s.created_ms < graceMs && s.status === "working")) {
          activeSessions.add(s.address);
        } else {
          orphans.push({
            session: s,
            task: null,
            taskId: null,
            reason: "finished_epic_agent",
            detail: "Epic agent cycle finished without archiving its session",
          });
        }
        continue;
      }

      if (taskId) {
        const task = tasksById.get(taskId) ?? null;
        if (!task) {
          orphans.push({
            session: s,
            task: null,
            taskId,
            reason: "missing_task",
            detail: `Linked task ${taskId} no longer exists in Corral`,
          });
          continue;
        }
        if (task.status === "open") {
          orphans.push({
            session: s,
            task,
            taskId,
            reason: "superseded_task",
            detail: "Task was reopened to open state while this session remained live",
          });
          continue;
        }
        if (task.terminal_address && task.terminal_address !== s.address) {
          orphans.push({
            session: s,
            task,
            taskId,
            reason: "superseded_task",
            detail: `Task was re-dispatched or respawned (current session: ${task.terminal_address})`,
          });
          continue;
        }
        if (task.status === "done" || task.status === "archived") {
          if (openPrTaskIds.has(task.id)) {
            activeSessions.add(s.address);
          } else {
            const detail = task.worktree_path
              ? `Task is ${task.status} with leftover worktree ${task.worktree_path}`
              : `Task is ${task.status} without a worktree; session was never archived`;
            orphans.push({
              session: s,
              task,
              taskId,
              reason: "terminal_task",
              detail,
            });
          }
          continue;
        }
        // task.status === "dispatched" (current session): always keep!
        activeSessions.add(s.address);
        if (
          (s.status === "idle" || s.status === "done" || s.status === "error") &&
          !openItemTaskIds.has(task.id) &&
          now - Math.max(task.updated_ms, s.created_ms) >= staleDispatchedMs
        ) {
          warnings.push({
            address: s.address,
            name: s.name,
            harness: s.harness,
            status: s.status,
            task_id: task.id,
            task_title: taskLabel(task),
            created_ms: s.created_ms,
            reason: "stale_dispatched",
            detail: `Dispatched task is ${s.status ?? "idle"} for >${this.cfg.staleDispatchedHours}h with no open inbox item`,
            action: "warning",
          });
        }
        continue;
      }

      if (s.parent) {
        deferredChildren.push(s);
        continue;
      }

      if (now - s.created_ms < graceMs) {
        activeSessions.add(s.address);
      } else {
        orphans.push({
          session: s,
          task: null,
          taskId: null,
          reason: "unlinked_corral",
          detail: "Corral-labelled session has no linked task, KPI, or epic record",
        });
      }
    }

    // Second pass: classify child sessions once parent statuses are settled.
    // Iteratively resolve chains of active parents -> active children.
    let childAdded = true;
    const unresolvedChildren = [...deferredChildren];
    while (childAdded && unresolvedChildren.length > 0) {
      childAdded = false;
      for (let i = unresolvedChildren.length - 1; i >= 0; i--) {
        const c = unresolvedChildren[i];
        if (c.parent && activeSessions.has(c.parent)) {
          activeSessions.add(c.address);
          unresolvedChildren.splice(i, 1);
          childAdded = true;
        }
      }
    }
    for (const c of unresolvedChildren) {
      orphans.push({
        session: c,
        task: null,
        taskId: null,
        reason: "orphaned_child",
        detail: `Parent session ${c.parent} is finished or missing`,
      });
    }

    // Step 3: Execute cleanup (or dry-run preview).
    const cleanedItems = await mapLimit(orphans, 4, async (candidate): Promise<SessionCleanupItem> => {
      const { session, task, taskId, reason, detail } = candidate;
      const base: Omit<SessionCleanupItem, "action" | "error"> = {
        address: session.address,
        name: session.name,
        harness: session.harness,
        status: session.status,
        task_id: taskId,
        task_title: task ? taskLabel(task) : null,
        created_ms: session.created_ms,
        reason,
        detail,
      };
      if (dryRun) {
        return { ...base, action: "would_clean" };
      }
      let action: SessionCleanupAction;
      try {
        if (reason === "terminal_task" && task && canCleanup(this.db, task)) {
          const removed = await cleanupFinishedTask(this.db, this.backend, task.id, {
            hub: this.hub,
            reason: "session-cleanup",
          });
          if (removed) {
            action = "worktree_cleaned";
          } else if (session.status === "working") {
            await this.backend.kill(session.address);
            action = "killed";
          } else if (this.backend.archive) {
            await this.backend.archive(session.address);
            action = "archived";
          } else {
            await this.backend.kill(session.address);
            action = "killed";
          }
        } else if (session.status === "working") {
          await this.backend.kill(session.address);
          action = "killed";
        } else if (this.backend.archive) {
          await this.backend.archive(session.address);
          action = "archived";
        } else {
          await this.backend.kill(session.address);
          action = "killed";
        }
        this.db.recordMetric("session.orphan_cleaned", session.address, {
          reason,
          task_id: taskId,
          harness: session.harness,
          action,
        });
        return { ...base, action };
      } catch (err) {
        return { ...base, action: "failed", error: err instanceof Error ? err.message : String(err) };
      }
    });

    const items = [...cleanedItems, ...warnings];
    const byReason: Partial<Record<SessionCleanupReason, number>> = {};
    for (const item of items) {
      byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
    }

    const cleaned = cleanedItems.filter(
      (i) => i.action === "archived" || i.action === "worktree_cleaned" || i.action === "killed",
    ).length;
    const wouldClean = cleanedItems.filter((i) => i.action === "would_clean").length;
    const failed = cleanedItems.filter((i) => i.action === "failed").length;

    const report: SessionCleanupReport = {
      id: randomUUID(),
      ran_ms: now,
      dry_run: dryRun,
      trigger,
      scanned: liveSessions.length,
      corral_owned: corralOwned.size,
      external_ignored: liveSessions.length - corralOwned.size,
      kept_active: activeSessions.size,
      cleaned,
      would_clean: wouldClean,
      failed,
      warnings: warnings.length,
      by_reason: byReason,
      items,
    };

    this.db.insertSessionCleanupRun(report);
    this.db.recordMetric("session.cleanup_run", report.id, {
      dry_run: dryRun,
      trigger,
      scanned: report.scanned,
      cleaned: report.cleaned,
      failed: report.failed,
      warnings: report.warnings,
      by_reason: report.by_reason,
    });
    if (cleaned > 0) {
      this.hub?.broadcast("session.updated", { cleanup_id: report.id, cleaned });
    }
    return report;
  }
}
