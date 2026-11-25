// What an Epic looks like right now: the state of each task, what blocks it,
// and which tasks can be launched. Pure over rows, so it is easy to test;
// starting a task is an explicit action on the Epic page, never a sync side effect.

import type { Hub } from "./capture.ts";
import type { Db } from "./db.ts";
import { isJiraDone, isJiraKilled } from "./epic.ts";
import type { EpicLink, EpicTicket, Item, Task } from "./types.ts";

export type EpicTaskState = "out" | "killed" | "merged" | "pr_ready" | "pr_open" | "running" | "ready" | "blocked";

export interface EpicBlocker {
  key: string;
  task_id: string | null;
  /** Merged, or its PR is green and ready: the dependent may start. */
  satisfied: boolean;
}

export interface EpicTaskView {
  task: Task;
  /** True when backed by a row in `tasks`; false when projected from synced `epic_tickets`. */
  has_task: boolean;
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

function ticketToTask(ticket: EpicTicket): Task {
  return {
    id: `ticket:${ticket.jira_key}`,
    title: ticket.title,
    prompt: ticket.description,
    kind: "code",
    repo_path: ticket.suggested_repo_path,
    target: "",
    target_state: "suggested",
    agent: null,
    model: null,
    reasoning: null,
    review: null,
    base_branch: null,
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: ticket.jira_key,
    jira_url: ticket.jira_url || null,
    jira_parent_key: ticket.jira_parent_key,
    jira_status: ticket.jira_status,
    pr_url: null,
    pr_meta: null,
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: ticket.updated_ms,
    updated_ms: ticket.updated_ms,
    epic_id: ticket.epic_id,
    epic_out: 0,
  };
}

export function epicViews(tasks: Task[], links: EpicLink[], items: Item[], tickets: EpicTicket[] = []): EpicTaskView[] {
  // The board mirrors Jira tickets. A task made from a request on the Epic
  // page has no ticket, so it stays on the Tasks page instead of this board.
  // Archived tasks are excluded so a synced Jira ticket can re-surface for re-launch.
  const boardTasks = tasks.filter((t) => t.jira_key && t.status !== "archived");
  const taskByKey = new Map(boardTasks.map((t) => [t.jira_key!, t]));
  const entries: { task: Task; has_task: boolean }[] = boardTasks.map((task) => ({ task, has_task: true }));
  for (const ticket of tickets) {
    if (!taskByKey.has(ticket.jira_key)) {
      entries.push({ task: ticketToTask(ticket), has_task: false });
    }
  }
  const entryByKey = new Map(entries.map((e) => [e.task.jira_key!, e]));
  const prs = prItemByTask(items);
  const prReady = (t: Task) => { const i = prs.get(t.id); return Boolean(i && i.status === "open" && i.ready === 1); };
  const closedUnmerged = (t: Task) => { const i = prs.get(t.id); return Boolean(t.pr_url && i && i.status === "resolved" && !isMerged(t)); };
  const satisfied = (t: Task) => t.epic_out === 1 || isJiraKilled(t.jira_status) || isMerged(t) || prReady(t);

  const views = entries.map(({ task, has_task }): EpicTaskView => {
    const blockers = links
      .filter((l) => l.task_key === task.jira_key)
      .map((l) => ({ key: l.blocked_by_key, dep: entryByKey.get(l.blocked_by_key) }))
      .map(({ key, dep }): EpicBlocker => ({
        key,
        task_id: dep?.has_task ? dep.task.id : null,
        satisfied: dep ? satisfied(dep.task) : true,
      }));
    const blocked = blockers.filter((b) => !b.satisfied);
    const closed = blockers.find((b) => {
      const dep = entryByKey.get(b.key);
      return dep?.has_task ? closedUnmerged(dep.task) : false;
    });
    const killed = blockers.find((b) => {
      const dep = entryByKey.get(b.key);
      return dep ? isJiraKilled(dep.task.jira_status) : false;
    });
    const item = has_task ? prs.get(task.id) : undefined;
    let state: EpicTaskState;
    if (task.epic_out === 1) state = "out";
    else if (isJiraKilled(task.jira_status)) state = "killed";
    else if (isMerged(task)) state = "merged";
    else if (has_task && prReady(task)) state = "pr_ready";
    else if (has_task && (task.pr_url || item)) state = "pr_open";
    else if (has_task && (task.status === "dispatched" || task.terminal_address)) state = "running";
    else state = blocked.length ? "blocked" : "ready";

    // Stack on the prerequisite's branch only when exactly one same-repo
    // prerequisite is still unmerged; otherwise the default branch.
    const open = blockers
      .map((b) => entryByKey.get(b.key))
      .filter((e): e is { task: Task; has_task: boolean } => Boolean(e) && !isMerged(e!.task) && !isJiraKilled(e!.task.jira_status) && e!.task.epic_out !== 1);
    const sameRepo = open.filter((e) => e.has_task && e.task.repo_path && e.task.repo_path === task.repo_path && e.task.branch);
    const stack_on = open.length === 1 && sameRepo.length === 1 ? sameRepo[0].task.branch : null;
    return {
      task, has_task, state, blockers,
      alert: closed
        ? `Prerequisite ${closed.key} PR was closed without merging`
        : killed ? `Prerequisite ${killed.key} was killed in Jira` : null,
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
    const d = Math.max(-1, ...links.filter((l) => l.task_key === key && entryByKey.has(l.blocked_by_key)).map((l) => depthOf(l.blocked_by_key, seen))) + 1;
    depth.set(key, d);
    return d;
  };
  const d = (v: EpicTaskView) => (v.task.jira_key ? depthOf(v.task.jira_key, new Set()) : 0);
  const terminal = (v: EpicTaskView) => v.state === "out" || v.state === "killed";
  return views.sort((a, b) => Number(terminal(a)) - Number(terminal(b)) || d(a) - d(b) || (a.task.jira_key ?? "").localeCompare(b.task.jira_key ?? "", undefined, { numeric: true }));
}

export function epicSummary(views: EpicTaskView[]): EpicSummary {
  const live = views.filter((v) => v.state !== "out" && v.state !== "killed");
  return {
    total: live.length,
    merged: live.filter((v) => v.state === "merged").length,
    testable: live.filter((v) => v.testable).length,
    ready: live.filter((v) => v.state === "ready").length,
    blocked: live.filter((v) => v.state === "blocked").length,
  };
}

/**
 * Older Corral versions created an open "Ready to launch" inbox item per
 * ready task. Syncs no longer create those items: starting an epic task is an
 * explicit action on the Epic page. Archive leftovers once their task is no
 * longer ready, so the inbox never offers to launch something stale.
 */
export function archiveEpicLaunchItems(db: Db, hub: Hub): void {
  const launchItems = db.listItems({ kind: "launch", status: "open" });
  if (launchItems.length === 0) return;
  const byTaskId = new Map<string, Item[]>();
  for (const item of launchItems) {
    if (!item.task_id) continue;
    const list = byTaskId.get(item.task_id);
    if (list) list.push(item);
    else byTaskId.set(item.task_id, [item]);
  }
  if (byTaskId.size === 0) return;
  const epicIds = new Set<string>();
  for (const task of db.getTasksByIds([...byTaskId.keys()])) {
    if (task.epic_id) epicIds.add(task.epic_id);
  }
  if (epicIds.size === 0) return;
  const prItems = db.listActivePrItems();
  for (const epicId of epicIds) {
    const views = epicViews(db.listEpicTasks(epicId), db.listEpicLinks(epicId), prItems, db.listEpicTickets(epicId));
    for (const v of views) {
      if (!v.has_task || v.state === "ready") continue;
      for (const existing of byTaskId.get(v.task.id) ?? []) {
        db.updateItem(existing.id, { status: "archived", resolved_ms: Date.now() });
        hub.broadcast("item.updated", db.getItem(existing.id));
      }
    }
  }
}

/**
 * Stack a ready task on the branch of its only unmerged same-repo prerequisite.
 * Done at launch, not during sync: merely becoming ready must not edit a task.
 */
export function stackEpicTaskOnPrerequisite(db: Db, hub: Hub, view: EpicTaskView): void {
  if (!view.stack_on) return;
  const task = db.getTask(view.task.id);
  if (!task || task.base_branch === view.stack_on) return;
  const blockerBranches = new Set(
    view.blockers.map((b) => (b.task_id ? db.getTask(b.task_id)?.branch : null)).filter(Boolean),
  );
  if (task.base_branch !== null && !blockerBranches.has(task.base_branch)) return;
  db.updateTask(task.id, { base_branch: view.stack_on }, false);
  hub.broadcast("task.updated", db.getTask(task.id));
}
