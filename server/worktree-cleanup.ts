// Worktree lifecycle: Corral decides when a task no longer needs its worktree,
// the worker backend owns the git operation. Cleanup is best effort: a failed
// removal leaves the task intact so a later pass can retry.

import { mapLimit } from "./exec.ts";
import type { Db } from "./db.ts";
import type { Hub } from "./capture.ts";
import type { WorkerBackend } from "./worker.ts";
import type { Task } from "./types.ts";
import { logTaskEvent } from "./task-events.ts";

const inFlight = new Set<string>();

/** An open PR item means the review loop may still need the branch. */
export function canCleanup(db: Db, task: Task | null | undefined): task is Task {
  if (!task || (task.status !== "done" && task.status !== "archived")) return false;
  if (!task.worktree_path || !task.terminal_address) return false;
  return !db.hasOpenPrItem(task.id);
}

/** Remove the worktree and its local branch. Returns true only on success. */
export async function cleanupFinishedTask(
  db: Db,
  backend: WorkerBackend,
  taskId: string,
  opts: { hub?: Hub; reason?: string } = {},
): Promise<boolean> {
  if (!backend.cleanup) return false;
  let task: Task | undefined;
  try {
    const current = db.getTask(taskId);
    if (!canCleanup(db, current) || inFlight.has(taskId)) return false;
    task = current;
    inFlight.add(task.id);
    await backend.cleanup(task.terminal_address!);
    // The branch stays on the task as a record of what was delivered; the
    // backend deleted the git branch and worktree, not the task history.
    db.updateTask(task.id, { worktree_path: null });
    db.recordMetric("task.worktree_removed", task.id, { how: opts.reason ?? "terminal" });
    opts.hub?.broadcast("task.updated", db.getTask(task.id));
    return true;
  } catch (err) {
    if (task) {
      const error = String(err);
      const expectedData = error ? JSON.stringify({ error }) : null;
      const last = db.listTaskEvents(task.id, 1)[0];
      const sameFailure = last?.kind === "session"
        && last.message === "Worktree cleanup failed"
        && last.data === expectedData;
      if (!sameFailure) {
        logTaskEvent(db, task.id, "session", "Worktree cleanup failed", { error });
      }
    }
    return false;
  } finally {
    if (task) inFlight.delete(task.id);
  }
}

/** Clean tasks that finished before this behavior existed, or whose first
 *  cleanup attempt failed. Runs after a PR sync so item states are current. */
export async function cleanupTerminalWorktrees(
  db: Db,
  backend: WorkerBackend,
  opts: { hub?: Hub } = {},
): Promise<number> {
  if (!backend.cleanup) return 0;
  const tasks = db.listCleanupCandidateTasks();
  const results = await mapLimit(tasks, 4, (task) => cleanupFinishedTask(db, backend, task.id, {
    hub: opts.hub,
    reason: "sweep",
  }));
  return results.filter(Boolean).length;
}
