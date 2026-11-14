// Multi-repo tasks. A `spec` task runs in a folder of sub-projects, writes the
// contract between them and proposes one code task per sub-project. The human
// approves the plan in the inbox; approval creates the code tasks. The contract
// lives on the spec task and is read back at each child's dispatch.

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Db } from "./db.ts";
import type { Hub } from "./capture.ts";
import { addRepo, gitToplevel } from "./repos.ts";
import { logTaskEvent } from "./task-events.ts";
import type { PlanSubtask, Task, TaskSpec } from "./types.ts";

export const MAX_SUBTASKS = 12;

export class PlanError extends Error {}

/** Parse a task's stored spec, null when absent or unreadable. */
export function readSpec(task: Pick<Task, "spec">): TaskSpec | null {
  if (!task.spec) return null;
  try {
    const parsed = JSON.parse(task.spec) as TaskSpec;
    return Array.isArray(parsed.subtasks) && typeof parsed.contract === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check the sub-tasks an agent proposed and resolve each `repo` to an absolute
 * git toplevel inside `folder`. The agent's text is untrusted: a path that
 * escapes the folder (`..`, absolute, symlink) or is not a git repo is refused.
 */
export function validateSubtasks(folder: string, raw: unknown): PlanSubtask[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new PlanError("subtasks must be a non-empty array");
  if (raw.length > MAX_SUBTASKS) throw new PlanError(`at most ${MAX_SUBTASKS} subtasks`);
  const root = realpathSync(folder);
  const out: PlanSubtask[] = [];
  const seen = new Set<string>();
  for (const entry of raw as Partial<PlanSubtask>[]) {
    const repo = typeof entry?.repo === "string" ? entry.repo.trim() : "";
    const title = typeof entry?.title === "string" ? entry.title.trim() : "";
    const prompt = typeof entry?.prompt === "string" ? entry.prompt.trim() : "";
    if (!repo || !title || !prompt) throw new PlanError("each subtask needs repo, title and prompt");
    if (isAbsolute(repo)) throw new PlanError(`subtask repo must be relative to the folder: ${repo}`);
    let real: string;
    try {
      real = realpathSync(resolve(root, repo));
    } catch {
      throw new PlanError(`subtask repo does not exist: ${repo}`);
    }
    const rel = relative(root, real);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new PlanError(`subtask repo is outside the folder: ${repo}`);
    }
    let top: string;
    try {
      top = realpathSync(gitToplevel(real));
    } catch {
      throw new PlanError(`subtask repo is not a git repository: ${repo}`);
    }
    // A nested directory of one repo would run two tasks in the same checkout.
    if (top !== real) throw new PlanError(`subtask repo is not a repository root: ${repo}`);
    if (seen.has(real)) throw new PlanError(`two subtasks target the same repo: ${repo}`);
    seen.add(real);
    out.push({ repo: rel, title, prompt });
  }
  return out;
}

/** The human-readable plan shown in the inbox item. */
export function planMarkdown(spec: TaskSpec): string {
  const lines = ["## Contract", "", spec.contract.trim(), "", "## Sub-tasks", ""];
  spec.subtasks.forEach((s, i) => {
    lines.push(`### ${i + 1}. ${s.title} — \`${s.repo}\``, "", s.prompt.trim(), "");
  });
  return lines.join("\n").trimEnd();
}

/** Contract block appended to a child's prompt at dispatch (one source of truth: the parent). */
export function contractBlock(db: Db, task: Task): string {
  if (!task.parent_task_id) return "";
  const parent = db.getTask(task.parent_task_id);
  const spec = parent ? readSpec(parent) : null;
  if (!spec) return "";
  return [
    "## Multi-repo contract",
    "",
    "This task is one part of a change spanning several repositories. The contract below was",
    "agreed with the human; implement your side of it and do not change it. If it cannot be",
    "met, report a question instead of diverging.",
    "",
    spec.contract.trim(),
  ].join("\n");
}

/**
 * Create one code task per proposed sub-task and complete the spec task.
 * Idempotent per spec: a second approval is refused.
 */
export function approvePlan(db: Db, hub: Hub, parent: Task): Task[] {
  if (parent.kind !== "spec") throw new PlanError("only spec tasks have a plan");
  const spec = readSpec(parent);
  if (!spec) throw new PlanError("the spec task has no plan yet");
  if (spec.children?.length) throw new PlanError("this plan was already approved");
  // Re-validate: the folder may have changed since the agent reported.
  const subtasks = validateSubtasks(parent.repo_path, spec.subtasks);
  const now = Date.now();
  const children: Task[] = subtasks.map((s) => ({
    id: randomUUID(),
    title: s.title,
    prompt: s.prompt,
    kind: "code",
    repo_path: realpathSync(resolve(parent.repo_path, s.repo)),
    target: parent.target,
    target_state: "suggested",
    model: null,
    reasoning: null,
    base_branch: null,
    branch: null,
    worktree_path: null,
    assignee: parent.assignee,
    jira_key: null,
    jira_url: null,
    jira_parent_key: parent.jira_key,
    pr_url: null,
    pr_meta: null,
    parent_task_id: parent.id,
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: now,
    updated_ms: now,
  }));
  for (const child of children) {
    addRepo(db, child.repo_path, { source: "manual" });
    db.insertTask(child);
    db.recordMetric("task.created", child.id, { source: "multi-repo" });
    logTaskEvent(db, child.id, "created", "Task created from a multi-repo plan", {
      source: "multi-repo",
      parent: parent.id,
      repo: child.repo_path,
    });
    hub.broadcast("task.updated", child);
  }
  const stored: TaskSpec = { ...spec, subtasks, children: children.map((c) => c.id) };
  db.updateTask(parent.id, { spec: JSON.stringify(stored), status: "done" });
  logTaskEvent(db, parent.id, "session", `Plan approved: ${children.length} tasks created`, {
    children: stored.children,
  });
  for (const item of db.listItems({ kind: "plan" })) {
    if (item.task_id === parent.id && item.status === "open") {
      db.updateItem(item.id, { status: "resolved", resolved_ms: now });
      hub.broadcast("item.updated", db.getItem(item.id));
    }
  }
  hub.broadcast("task.updated", db.getTask(parent.id));
  return children;
}
