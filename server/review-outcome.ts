// Review publish outcome: whether a review task's draft comments were posted.
//
// skills/review.md asks the human "Publish N review comments on …?" and only
// publishes after a reply. An archived question used to leave no trace of
// what happened to the drafts. This records the outcome on the task from what
// Corral observes; it never asks the human again.

import type { Db } from "./db.ts";
import { logTaskEvent } from "./task-events.ts";
import type { Item, ReviewOutcome, Task } from "./types.ts";

type Hub = { broadcast: (type: string, data: unknown) => void };

const PUBLISH_TITLE = /^\s*publish\s+\d+\s+review\s+comments?\b/i;

/** The question skills/review.md step 5 sends, not any other review question. */
export function isPublishQuestion(item: Pick<Item, "kind" | "title" | "options">): boolean {
  if (item.kind !== "question") return false;
  if (PUBLISH_TITLE.test(item.title)) return true;
  try {
    const options = JSON.parse(item.options ?? "null") as unknown;
    return Array.isArray(options) && options.some((o) => typeof o === "string" && o.trim().toLowerCase() === "publish all");
  } catch {
    return false;
  }
}

/** "none" is the decline answer the review skill offers. */
export function isDeclineReply(text: string): boolean {
  return /^\s*none\s*\.?\s*$/i.test(text);
}

function replied(db: Db, itemId: string): boolean {
  return Boolean(db.raw.prepare("SELECT 1 FROM metrics_events WHERE name = 'item.replied' AND ref = ? LIMIT 1").get(itemId));
}

function reviewTask(db: Db, item: Item): Task | null {
  const task = item.task_id ? db.getTask(item.task_id) : null;
  return task && task.kind === "review" ? task : null;
}

/** The first outcome wins: a "none" reply stays skipped even if the agent
 *  later reports "Review published" with zero comments. */
function record(db: Db, hub: Hub | undefined, task: Task, outcome: ReviewOutcome, reason: string, itemId: string): void {
  if (task.review_outcome) return;
  db.updateTask(task.id, { review_outcome: outcome }, false);
  db.recordMetric("review.outcome", task.id, { outcome, reason, item_id: itemId });
  logTaskEvent(db, task.id, "updated", outcome === "published" ? "Review comments published" : `Review comments not published: ${reason}`, {
    outcome,
    reason,
    item_id: itemId,
  });
  hub?.broadcast("task.updated", db.getTask(task.id));
}

/** The human answered the publish question. Only "none" settles it now;
 *  any other answer is settled by the agent's done report. */
export function reviewReplied(db: Db, hub: Hub | undefined, item: Item, text: string): void {
  const task = reviewTask(db, item);
  if (!task || !isPublishQuestion(item) || !isDeclineReply(text)) return;
  record(db, hub, task, "skipped", "declined", item.id);
}

/** The human archived or acknowledged the publish question. Without a reply
 *  the agent never got approval, so nothing was published. */
export function reviewQuestionClosed(db: Db, hub: Hub | undefined, item: Item, how: "archived" | "acknowledged"): void {
  const task = reviewTask(db, item);
  if (!task || !isPublishQuestion(item) || replied(db, item.id)) return;
  record(db, hub, task, "skipped", `${how} without reply`, item.id);
}

/** The review agent reported done: if the human approved some comments, the
 *  agent published them. No answered publish question leaves it unknown. */
export function reviewReportedDone(db: Db, hub: Hub | undefined, taskId: string): void {
  const task = db.getTask(taskId);
  if (!task || task.kind !== "review" || task.review_outcome) return;
  const approved = db.listItems({ kind: "question" }).find((i) => i.task_id === taskId && isPublishQuestion(i) && replied(db, i.id));
  if (approved) record(db, hub, task, "published", "agent reported done after approval", approved.id);
}
