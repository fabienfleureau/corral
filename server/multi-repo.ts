// Multi-repo tasks. A `spec` task runs in a folder of sub-projects, writes the
// contract between them and proposes one code task per sub-project. The human
// approves the plan in the inbox; approval creates and dispatches the code
// tasks. The contract lives on the spec task and is read back at each child's dispatch.

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Db } from "./db.ts";
import type { Hub } from "./capture.ts";
import { addRepo, gitToplevel } from "./repos.ts";
import { logTaskEvent } from "./task-events.ts";
import type { Item, PlanReview, PlanReviewComment, PlanRevision, PlanSubtask, Task, TaskSpec } from "./types.ts";
import type { WorkerBackend } from "./worker.ts";

export const MAX_SUBTASKS = 12;

export class PlanError extends Error {}

export class PlanConflictError extends PlanError {
  readonly currentRevisionId: string | null;
  readonly currentVersion: number | null;
  constructor(message: string, opts: { currentRevisionId?: string | null; currentVersion?: number | null } = {}) {
    super(message);
    this.currentRevisionId = opts.currentRevisionId ?? null;
    this.currentVersion = opts.currentVersion ?? null;
  }
}

export class PlanDeliveryError extends PlanError {}

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

/** Synthesize a v1 revision when reading a legacy spec task predating `plan_revisions`. */
export function listTaskPlanRevisions(db: Db, task: Task): {
  current_revision_id: string | null;
  approved_revision_id: string | null;
  revisions: PlanRevision[];
  reviews: PlanReview[];
} {
  if (task.kind !== "spec") throw new PlanError("only spec tasks have plan revisions");
  const spec = readSpec(task);
  let revisions = db.listPlanRevisions(task.id);
  if (revisions.length === 0 && spec) {
    revisions = [{
      id: spec.revision_id ?? `legacy-${task.id}`,
      task_id: task.id,
      version: spec.version ?? 1,
      title: task.title || "Plan",
      contract: spec.contract,
      subtasks: spec.subtasks,
      markdown: planMarkdown(spec),
      created_ms: task.updated_ms || task.created_ms,
    }];
  }
  const current_revision_id = revisions[revisions.length - 1]?.id ?? null;
  const approved_revision_id = spec?.children?.length ? (spec.revision_id ?? current_revision_id) : null;
  return {
    current_revision_id,
    approved_revision_id,
    revisions,
    reviews: db.listPlanReviews(task.id),
  };
}

/** Validate the request payload for `POST /api/tasks/:id/request-plan-changes`. */
export function validatePlanReviewInput(raw: unknown): {
  revisionId: string;
  note: string;
  comments: PlanReviewComment[];
} {
  const b = (raw && typeof raw === "object" ? raw : {}) as {
    revision_id?: unknown;
    note?: unknown;
    comments?: unknown;
  };
  const revisionId = typeof b.revision_id === "string" ? b.revision_id.trim() : "";
  if (!revisionId) throw new PlanError("revision_id is required");
  const note = typeof b.note === "string" ? b.note.trim() : "";
  const comments: PlanReviewComment[] = [];
  if (b.comments !== undefined) {
    if (!Array.isArray(b.comments)) throw new PlanError("comments must be an array");
    for (const entry of b.comments as Partial<PlanReviewComment>[]) {
      const section = typeof entry?.section === "string" ? entry.section.trim() : "";
      const quote = typeof entry?.quote === "string" ? entry.quote.trim() : "";
      const body = typeof entry?.body === "string" ? entry.body.trim() : "";
      const repo = typeof entry?.repo === "string" && entry.repo.trim() ? entry.repo.trim() : null;
      if (!section || !quote || !body) throw new PlanError("each comment needs section, quote and body");
      comments.push({ section, repo, quote, body });
    }
  }
  if (!note && comments.length === 0) throw new PlanError("provide at least one comment or a note");
  return { revisionId, note, comments };
}

/** Prompt sent via WorkerBackend.send when the human requests changes to a plan revision. */
export function planRevisionPrompt(version: number, note: string, comments: PlanReviewComment[]): string {
  const parts: string[] = [`The human requested changes to plan v${version}.`];
  const trimmedNote = note.trim();
  if (trimmedNote) parts.push(trimmedNote);
  if (comments.length > 0) {
    const items = comments.map((c, i) => {
      const quoted = c.quote.trim().split(/\r?\n/).map((line) => `   > ${line}`).join("\n");
      const body = c.body.trim().split(/\r?\n/).map((line) => `   ${line}`).join("\n");
      return `${i + 1}. **Section:** ${c.section}\n${quoted}\n${body}`;
    });
    parts.push(`### Review comments\n\n${items.join("\n\n")}`);
  }
  parts.push('Update the contract and sub-tasks to address every comment, then submit the revised plan via `POST /api/reports` with `kind: "plan"`. Do not edit repository files.');
  return parts.join("\n\n");
}

/**
 * Deliver revision feedback to the spec task's live session, persist the review,
 * and mark the single open plan item as `handling = 1` (In progress).
 */
export async function requestPlanChanges(
  db: Db,
  hub: Hub,
  backend: WorkerBackend,
  parent: Task,
  input: { revisionId: string; note: string; comments: PlanReviewComment[] },
): Promise<{ review: PlanReview; item: Item | null; sent_to: string }> {
  if (parent.kind !== "spec") throw new PlanError("only spec tasks have a plan");
  const spec = readSpec(parent);
  if (!spec) throw new PlanError("the spec task has no plan yet");
  const currentRevisionId = spec.revision_id ?? `legacy-${parent.id}`;
  const currentVersion = spec.version ?? 1;
  if (spec.children?.length) {
    throw new PlanConflictError("this plan was already approved", { currentRevisionId, currentVersion });
  }
  if (input.revisionId !== currentRevisionId) {
    throw new PlanConflictError("A newer plan revision arrived; review it before requesting changes.", {
      currentRevisionId,
      currentVersion,
    });
  }
  const openItem = db.findOpenItemForTask(parent.id, "plan");
  const address = parent.terminal_address || openItem?.source_ref || null;
  if (!address) {
    throw new PlanConflictError("No active agent session for this spec task.", { currentRevisionId, currentVersion });
  }
  const message = planRevisionPrompt(currentVersion, input.note, input.comments);
  try {
    await backend.send(address, message);
  } catch (err) {
    throw new PlanDeliveryError(`Failed to send plan feedback to session ${address}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const now = Date.now();
  const review: PlanReview = {
    id: randomUUID(),
    task_id: parent.id,
    revision_id: currentRevisionId,
    note: input.note,
    comments: input.comments,
    created_ms: now,
  };
  db.insertPlanReview(review);
  let updatedItem: Item | null = null;
  if (openItem) {
    db.updateItem(openItem.id, { handling: 1, snooze_until_ms: null, updated_ms: now });
    updatedItem = db.getItem(openItem.id);
    if (updatedItem) hub.broadcast("item.updated", updatedItem);
  }
  logTaskEvent(db, parent.id, "session", `Requested changes on plan v${currentVersion}`, {
    revision_id: currentRevisionId,
    version: currentVersion,
    review_id: review.id,
    comments: input.comments.length,
  });
  return { review, item: updatedItem, sent_to: address };
}

export interface PlanDispatchFailure {
  task_id: string;
  title: string;
  error: string;
}

export interface ApprovePlanResult {
  children: Task[];
  dispatch_errors: PlanDispatchFailure[];
}

/**
 * Create and dispatch one code task per proposed sub-task and complete the spec task.
 * Idempotent per spec: a second approval is refused.
 */
export async function approvePlan(
  db: Db,
  hub: Hub,
  parent: Task,
  revisionId: string | undefined,
  dispatchChild: (child: Task, target: string) => Promise<unknown>,
): Promise<ApprovePlanResult> {
  if (parent.kind !== "spec") throw new PlanError("only spec tasks have a plan");
  const spec = readSpec(parent);
  if (!spec) throw new PlanError("the spec task has no plan yet");
  if (spec.children?.length) throw new PlanError("this plan was already approved");
  if (spec.revision_id) {
    if (!revisionId) throw new PlanError("revision_id is required");
    if (revisionId !== spec.revision_id) {
      throw new PlanConflictError("A newer plan revision arrived; review it before approving.", {
        currentRevisionId: spec.revision_id,
        currentVersion: spec.version ?? null,
      });
    }
  }
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
    agent: parent.agent ?? null,
    model: parent.model ?? null,
    reasoning: parent.reasoning ?? null,
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
  for (const item of db.listOpenItemsForTask(parent.id, "plan")) {
    db.updateItem(item.id, { status: "resolved", resolved_ms: now });
    hub.broadcast("item.updated", db.getItem(item.id));
  }
  hub.broadcast("task.updated", db.getTask(parent.id));

  const dispatch_errors: PlanDispatchFailure[] = [];
  const finalChildren: Task[] = [];
  for (const child of children) {
    const target = child.target.trim();
    if (!target) {
      const error = "task has no harness — pick one on the Tasks page to dispatch";
      dispatch_errors.push({ task_id: child.id, title: child.title, error });
      logTaskEvent(db, child.id, "session", "Auto-dispatch after plan approval skipped: no harness", {
        source: "multi-repo",
        parent: parent.id,
        error,
      });
      finalChildren.push(db.getTask(child.id) ?? child);
      continue;
    }
    try {
      await dispatchChild(child, target);
      const updated = db.getTask(child.id) ?? child;
      hub.broadcast("task.updated", updated);
      finalChildren.push(updated);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      dispatch_errors.push({ task_id: child.id, title: child.title, error });
      logTaskEvent(db, child.id, "session", "Auto-dispatch after plan approval failed", {
        source: "multi-repo",
        parent: parent.id,
        error,
      });
      finalChildren.push(db.getTask(child.id) ?? child);
    }
  }

  const dispatchedCount = finalChildren.length - dispatch_errors.length;
  const noun = finalChildren.length === 1 ? "task" : "tasks";
  const summary = dispatch_errors.length === 0
    ? `Plan approved: ${finalChildren.length} ${noun} created and dispatched`
    : `Plan approved: ${finalChildren.length} ${noun} created (${dispatchedCount} dispatched, ${dispatch_errors.length} failed)`;
  logTaskEvent(db, parent.id, "session", summary, {
    children: stored.children,
    dispatched: dispatchedCount,
    ...(dispatch_errors.length ? { dispatch_errors } : {}),
    ...(spec.revision_id ? { revision_id: spec.revision_id } : {}),
    ...(spec.version ? { version: spec.version } : {}),
  });

  return { children: finalChildren, dispatch_errors };
}
