// What an Epic looks like right now: the state of each task, what blocks it,
// and which tasks are ready to launch. Pure over rows, so it is easy to test;
// `syncEpicLaunch` turns "ready" into inbox items and the stacked-branch base.

import { randomUUID } from "node:crypto";
import type { Hub } from "./capture.ts";
import type { Db } from "./db.ts";
import { isJiraDone } from "./epic.ts";
import type { EpicLink, Item, Task } from "./types.ts";

export type EpicTaskState = "out" | "merged" | "pr_ready" | "pr_open" | "running" | "ready" | "blocked";

export interface EpicBlocker {
  key: string;
  task_id: string | null;
  /** Merged, or its PR is green and ready: the dependent may start. */
  satisfied: boolean;
}

export interface EpicTaskView {
  task: Task;
  state: EpicTaskState;
  blockers: EpicBlocker[];
  /** A prerequisite PR was closed without merging: its dependents stay blocked. */
  alert: string | null;
  /** The code can be tried: its PR is green and ready, or merged. */
  testable: boolean;
  /** Same-repo branch the task should stack on, null for the default branch. */
  stack_on: string | null;
}

export interface EpicSummary {
  total: number;
  merged: number;
  testable: number;
  ready: number;
  blocked: number;
}

const isMerged = (t: Task) => t.status === "done" || isJiraDone(t.jira_status);

/** PR items by task id: the open (not archived, not resolved) one when it exists. */
function prItemByTask(items: Item[]): Map<string, Item> {
  const out = new Map<string, Item>();
  for (const i of items) {
    if (i.kind !== "pr" || !i.task_id || i.status === "archived") continue;
    const cur = out.get(i.task_id);
    if (!cur || (cur.status !== "open" && i.status === "open")) out.set(i.task_id, i);
  }
  return out;
}

export function epicViews(tasks: Task[], links: EpicLink[], items: Item[]): EpicTaskView[] {
  const byKey = new Map(tasks.filter((t) => t.jira_key).map((t) => [t.jira_key!, t]));
  const prs = prItemByTask(items);
  const prReady = (t: Task) => { const i = prs.get(t.id); return Boolean(i && i.status === "open" && i.ready === 1); };
  const closedUnmerged = (t: Task) => { const i = prs.get(t.id); return Boolean(t.pr_url && i && i.status === "resolved" && !isMerged(t)); };
  const satisfied = (t: Task) => t.epic_out === 1 || isMerged(t) || prReady(t);

  const views = tasks.map((task): EpicTaskView => {
    const blockers = links
      .filter((l) => l.task_key === task.jira_key)
      .map((l) => ({ key: l.blocked_by_key, t: byKey.get(l.blocked_by_key) }))
      .map(({ key, t }): EpicBlocker => ({ key, task_id: t?.id ?? null, satisfied: t ? satisfied(t) : true }));
    const blocked = blockers.filter((b) => !b.satisfied);
    const closed = blockers.find((b) => { const t = b.task_id ? tasks.find((x) => x.id === b.task_id) : null; return t ? closedUnmerged(t) : false; });
    const item = prs.get(task.id);
    let state: EpicTaskState;
    if (task.epic_out === 1) state = "out";
    else if (isMerged(task)) state = "merged";
    else if (prReady(task)) state = "pr_ready";
    else if (task.pr_url || item) state = "pr_open";
    else if (task.status === "dispatched" || task.terminal_address) state = "running";
    else state = blocked.length ? "blocked" : "ready";

    // Stack on the prerequisite's branch only when exactly one same-repo
    // prerequisite is still unmerged; otherwise the default branch.
    const open = blockers
      .map((b) => (b.task_id ? tasks.find((t) => t.id === b.task_id)! : null))
      .filter((t): t is Task => Boolean(t) && !isMerged(t!) && t!.epic_out !== 1);
    const sameRepo = open.filter((t) => t.repo_path && t.repo_path === task.repo_path && t.branch);
    const stack_on = open.length === 1 && sameRepo.length === 1 ? sameRepo[0].branch : null;
    return {
      task, state, blockers,
      alert: closed ? `Prerequisite ${closed.key} PR was closed without merging` : null,
      testable: state === "merged" || state === "pr_ready",
      stack_on,
    };
  });

  // Order by dependency depth, then key: a prerequisite always comes first.
  const depth = new Map<string, number>();
  const depthOf = (key: string, seen: Set<string>): number => {
    if (depth.has(key)) return depth.get(key)!;
    if (seen.has(key)) return 0; // cycle: reported on the epic, never loops here
    seen.add(key);
    const d = Math.max(-1, ...links.filter((l) => l.task_key === key && byKey.has(l.blocked_by_key)).map((l) => depthOf(l.blocked_by_key, seen))) + 1;
    depth.set(key, d);
    return d;
  };
  const d = (v: EpicTaskView) => (v.task.jira_key ? depthOf(v.task.jira_key, new Set()) : 0);
  return views.sort((a, b) => Number(a.state === "out") - Number(b.state === "out") || d(a) - d(b) || (a.task.jira_key ?? "").localeCompare(b.task.jira_key ?? "", undefined, { numeric: true }));
}

export function epicSummary(views: EpicTaskView[]): EpicSummary {
  const live = views.filter((v) => v.state !== "out");
  return {
    total: live.length,
    merged: live.filter((v) => v.state === "merged").length,
    testable: live.filter((v) => v.testable).length,
    ready: live.filter((v) => v.state === "ready").length,
    blocked: live.filter((v) => v.state === "blocked").length,
  };
}

const launchRef = (taskId: string) => `epic-launch:${taskId}`;

/**
 * Keep one open "ready to launch" inbox item per ready task, and archive it
 * once the task has started or is blocked again. Also sets the stacked base
 * branch of an unstarted task. Never dispatches anything.
 */
export function syncEpicLaunch(db: Db, hub: Hub): void {
  const items = db.listItems();
  for (const epic of db.listEpics()) {
    const views = epicViews(db.listEpicTasks(epic.id), db.listEpicLinks(epic.id), items);
    for (const v of views) {
      const existing = items.find((i) => i.kind === "launch" && i.source_ref === launchRef(v.task.id) && i.status === "open");
      if (v.state === "ready") {
        const t = db.getTask(v.task.id)!;
        const blockerBranches = new Set(v.blockers.map((b) => (b.task_id ? db.getTask(b.task_id)?.branch : null)).filter(Boolean));
        if (t.base_branch !== v.stack_on && (t.base_branch === null || blockerBranches.has(t.base_branch))) {
          db.updateTask(t.id, { base_branch: v.stack_on }, false);
          hub.broadcast("task.updated", db.getTask(t.id));
        }
        if (existing) continue;
        const body = [
          `Every prerequisite of **${v.task.title}** is ready (PR green and ready, or merged).`,
          v.blockers.length ? `\nPrerequisites: ${v.blockers.map((b) => b.key).join(", ")}` : "",
          v.stack_on ? `\nStacked on branch \`${v.stack_on}\`.` : "",
          !v.task.repo_path ? "\nNo repository yet: pick one on the task before launching." : "",
        ].join("");
        const now = Date.now();
        const item: Item = {
          id: randomUUID(), kind: "launch", status: "open", title: `Ready to launch: ${v.task.title}`,
          summary: `Epic ${epic.jira_key}`, body, context: "", options: null, ready: 1, handling: 0,
          source_ref: launchRef(v.task.id), task_id: v.task.id, structured: 1,
          created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null,
        };
        db.insertItem(item);
        db.recordMetric("item.created", item.id, { kind: "launch", capture: "epic", task_id: v.task.id });
        hub.broadcast("item.created", item);
      } else if (existing) {
        db.updateItem(existing.id, { status: "archived", resolved_ms: Date.now() });
        hub.broadcast("item.updated", db.getItem(existing.id));
      }
    }
  }
}
