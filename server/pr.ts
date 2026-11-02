// PR discovery: Corral finds the PR/MR for a task's branch itself, so the
// review link shows up even when the agent forgets its completion report.
// GitHub via `gh`, GitLab via `glab` — whichever the repo speaks.

import { execFileSync } from "node:child_process";
import type { Db } from "./db.ts";
import type { Hub } from "./capture.ts";
import type { Item, Task } from "./types.ts";

export interface PrInfo {
  url: string;
  title: string;
  /** OPEN | MERGED | CLOSED (GitHub) / opened | merged | closed (GitLab), normalized to upper. */
  state: string;
  number: number;
}

export function findPr(repoPath: string, branch: string): PrInfo | null {
  if (!repoPath || !branch) return null;

  // GitHub
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "url,title,state,number"],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const list = JSON.parse(out) as { url: string; title: string; state: string; number: number }[];
    if (list.length > 0) {
      return { url: list[0].url, title: list[0].title, state: list[0].state.toUpperCase(), number: list[0].number };
    }
    return null;
  } catch {
    /* not GitHub or gh unavailable — try GitLab */
  }

  // GitLab
  try {
    const out = execFileSync(
      "glab",
      ["mr", "list", "--source-branch", branch, "--all", "--output", "json"],
      { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const list = JSON.parse(out) as { web_url: string; title: string; state: string; iid: number }[];
    if (list.length > 0) {
      return {
        url: list[0].web_url,
        title: list[0].title,
        state: list[0].state.toUpperCase(),
        number: list[0].iid,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check a task's branch for a PR and reflect it into Corral:
 *  - task.pr_url is set (visible on the task row),
 *  - one inbox item (kind "pr") exists per task — open while the PR is open,
 *    auto-resolved once it merges/closes.
 */
export function syncTaskPr(db: Db, hub: Hub, task: Task): PrInfo | null {
  const pr = findPr(task.repo_path, task.branch ?? "");
  if (!pr) return null;

  if (task.pr_url !== pr.url) {
    db.updateTask(task.id, { pr_url: pr.url });
    db.recordMetric("task.pr_found", task.id, { url: pr.url, state: pr.state });
    hub.broadcast("task.updated", db.getTask(task.id));
  }

  const existing = db.listItems({ kind: "pr" }).find((i) => i.task_id === task.id) ?? null;
  const shouldResolve = pr.state !== "OPEN";

  if (!existing) {
    const item: Item = {
      id: crypto.randomUUID(),
      kind: "pr",
      status: shouldResolve ? "resolved" : "open",
      title: `PR ready: ${task.title}`,
      summary: pr.title,
      body: `${pr.title}\n\n${pr.url}`,
      context: "",
      options: null,
      source_ref: task.terminal_address,
      task_id: task.id,
      structured: 1,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      resolved_ms: shouldResolve ? Date.now() : null,
      snooze_until_ms: null,
    };
    db.insertItem(item);
    db.recordMetric("item.created", item.id, { kind: "pr", capture: "pr-sync", task_id: task.id });
    hub.broadcast("item.created", item);
  } else if (shouldResolve && existing.status === "open") {
    db.updateItem(existing.id, { status: "resolved", resolved_ms: Date.now() });
    db.recordMetric("item.resolved", existing.id, { how: "pr-merged" });
    hub.broadcast("item.updated", db.getItem(existing.id));
  } else if (!shouldResolve && existing.status === "resolved" && !existing.resolved_ms) {
    db.updateItem(existing.id, { status: "open" });
    hub.broadcast("item.updated", db.getItem(existing.id));
  }

  return pr;
}

/** Tasks whose branch may have a PR: dispatched/done, with a repo and branch. */
export function prCandidateTasks(db: Db): Task[] {
  return db
    .listTasks()
    .filter((t) => (t.status === "dispatched" || t.status === "done") && t.branch && t.repo_path);
}
