import type { Item, Repo, SessionInfo, Task, TrackedTerminal } from "./types.js";

/** The agent has the item: no human action needed while its run is in flight. */
export function isHandlingItem(item: Item): boolean {
  return (item.handling ?? 0) === 1;
}

export function selectedInboxItem(previous: Item | null, items: Item[], status: Item["status"] | "snoozed" | "in-progress"): Item | null {
  if (!previous) return null;
  const keep = (item: Item) =>
    status === "snoozed"
      ? item.status === "open" && !isHandlingItem(item)
      : status === "in-progress"
        ? item.status !== "archived" && isHandlingItem(item)
        : item.status === status && !isHandlingItem(item);
  return items.find((item) => item.id === previous.id && keep(item)) ?? null;
}

export function visibleInboxItems(items: Item[], now: number, view: "visible" | "snoozed" = "visible"): Item[] {
  if (view === "snoozed") return items.filter((item) => item.status === "open" && !isHandlingItem(item) && item.snooze_until_ms !== null && item.snooze_until_ms > now);
  return items.filter((item) => item.status !== "open" || item.snooze_until_ms === null || item.snooze_until_ms <= now);
}

/** Open items that ask the human for something — the agent is not on them. */
export function openInboxItems(items: Item[]): Item[] {
  return items.filter((item) => item.status === "open" && !isHandlingItem(item));
}

/** Items the agent is actively handling (e.g. PR review comments or rebase).
 *  Dispatched tasks themselves are listed once by `inProgressInboxTasks`, so
 *  resolved items for those tasks are not repeated here. */
export function inProgressInboxItems(items: Item[], _tasks: Task[] = []): Item[] {
  return items.filter((item) => item.status !== "archived" && isHandlingItem(item));
}

/** Dispatched tasks not already represented by an actively handled item, so a
 *  running session appears once under In progress instead of twice. */
export function inProgressInboxTasks(tasks: Task[], items: Item[] = []): Task[] {
  const handledTasks = new Set<string>();
  const handledSessions = new Set<string>();
  for (const item of items) {
    if (item.status === "archived" || !isHandlingItem(item)) continue;
    if (item.task_id) handledTasks.add(item.task_id);
    if (item.source_ref) handledSessions.add(item.source_ref);
  }
  return tasks.filter(
    (task) =>
      task.status === "dispatched" &&
      !handledTasks.has(task.id) &&
      (!task.terminal_address || !handledSessions.has(task.terminal_address)),
  );
}

export type AgentRunStatus = "running" | "stopped" | "unknown";

const STOPPED_STATUSES = new Set(["idle", "done", "error"]);

/** State of the Omnigent session behind a task, independent of Corral's task status.
 *  A live session answers first; tracked terminals keep the last status when the
 *  worker is unreachable or the session is no longer listed. */
export function agentRunStatus(task: Task, sessions: SessionInfo[], terminals: TrackedTerminal[]): AgentRunStatus {
  const address = task.terminal_address;
  const session = sessions.find((s) => address ? s.address === address : s.task_id === task.id);
  if (session) {
    if (session.state === "finished") return "stopped";
    if (!session.status) return session.state === "live" ? "running" : "unknown";
    return STOPPED_STATUSES.has(session.status) ? "stopped" : "running";
  }
  const terminal = terminals.find((t) => address ? t.address === address : t.task_id === task.id);
  if (!terminal?.last_status) return "unknown";
  return STOPPED_STATUSES.has(terminal.last_status) ? "stopped" : "running";
}

export type TaskLocation = {
  /** Registered repo name, or the folder's basename when unregistered. */
  label: string;
  /** Full path (for tooltips and the detail pane). */
  path: string;
  /** True when the path matches a registered repository. */
  isRepo: boolean;
};

function trimTrailingSlashes(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  return withoutTrailing || trimmed[0];
}

function pathBasename(path: string): string {
  const normalized = trimTrailingSlashes(path);
  if (!normalized) return "";
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

/** Resolve a task's repo or working folder for display in the inbox. */
export function taskLocation(task: Pick<Task, "repo_path"> | null | undefined, repos: Repo[]): TaskLocation | null {
  const raw = task?.repo_path?.trim();
  if (!raw) return null;
  const normalized = trimTrailingSlashes(raw);
  const repo = repos.find((r) => trimTrailingSlashes(r.path) === normalized);
  if (repo) {
    return { label: repo.name || pathBasename(repo.path), path: repo.path, isRepo: true };
  }
  return { label: pathBasename(normalized), path: raw, isRepo: false };
}
