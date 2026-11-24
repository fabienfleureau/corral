import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { STOPPED_DETECTION_START_MS, stoppedRunRate } from "../improvement-metrics.ts";
import { STOPPED_ESCALATED_METRIC } from "../stopped-retry.ts";
import type { Item, Task } from "../types.ts";

const DAY = 86_400_000;
const PIVOT = 1_800_000_000_000;
const NOW = PIVOT + 20 * DAY;

function addTask(db: Db, id: string, target: string): void {
  db.insertTask({
    id, title: id, prompt: id, repo_path: "/repos/app", target, target_state: "confirmed", base_branch: "main",
    branch: null, worktree_path: null, assignee: null, jira_key: null, jira_url: null, jira_parent_key: null,
    pr_url: null, pr_meta: null, status: "done", terminal_address: null, exit_code: null,
    created_ms: PIVOT - 30 * DAY, updated_ms: PIVOT - 30 * DAY,
  } as Task);
}

function addItem(db: Db, id: string, taskId: string, title: string, created: number): void {
  db.insertItem({
    id, kind: "question", status: "resolved", title, summary: "", body: "", context: "", options: null, ready: 1,
    source_ref: null, task_id: taskId, structured: 0, created_ms: created, updated_ms: created, resolved_ms: created,
    snooze_until_ms: null,
  } as Item);
}

function metric(db: Db, ts: number, name: string, ref: string, data: unknown): void {
  db.raw.prepare("INSERT INTO metrics_events (ts, name, ref, data) VALUES (?, ?, ?, ?)").run(ts, name, ref, JSON.stringify(data));
}

test("stopped-run rate: counts escalations per dispatch and harness, before and after the pivot", () => {
  const db = new Db(":memory:");
  // Before: two codex dispatches, one escalated through the legacy capture event.
  addTask(db, "a", "codex");
  metric(db, PIVOT - 5 * DAY, "task.dispatched", "a", { target: "codex" });
  addItem(db, "qa", "a", "a — stopped without reporting", PIVOT - 5 * DAY + 1000);
  metric(db, PIVOT - 5 * DAY + 1000, "item.created", "qa", { kind: "question", capture: "idle-fallback", task_id: "a" });
  addTask(db, "b", "codex");
  metric(db, PIVOT - 4 * DAY, "task.dispatched", "b", { target: "codex" });

  // Before: an old claude row only recognisable by its title; a "needs you"
  // capture is not a stopped run.
  addTask(db, "c", "claude");
  metric(db, PIVOT - 3 * DAY, "task.dispatched", "c", {});
  addItem(db, "qc", "c", "Agent run failed", PIVOT - 3 * DAY + 1000);
  addItem(db, "qc2", "c", "c — needs you", PIVOT - 3 * DAY + 2000);

  // Dispatched before the pivot, escalated after it: belongs to "before".
  addTask(db, "d", "claude");
  metric(db, PIVOT - 1000, "task.dispatched", "d", { target: "claude" });
  metric(db, PIVOT + DAY, STOPPED_ESCALATED_METRIC, "d", { item_id: "qd", category: "error", attempts: 2 });

  // After: the task now targets pi, but it ran on codex. The same item
  // reopened twice counts twice; its item.created event is not a third.
  addTask(db, "e", "pi");
  metric(db, PIVOT + 2 * DAY, "task.dispatched", "e", { target: "codex" });
  addItem(db, "qe", "e", "e — run failed", PIVOT + 2 * DAY + 500);
  metric(db, PIVOT + 2 * DAY + 500, "item.created", "qe", { kind: "question", capture: "idle-fallback", task_id: "e" });
  metric(db, PIVOT + 2 * DAY + 501, STOPPED_ESCALATED_METRIC, "e", { item_id: "qe", category: "error", attempts: 2 });
  metric(db, PIVOT + 3 * DAY, STOPPED_ESCALATED_METRIC, "e", { item_id: "qe", category: "silent", attempts: 1 });
  addTask(db, "f", "claude");
  metric(db, PIVOT + 4 * DAY, "task.dispatched", "f", { target: "claude" });

  // Dispatched before the first window: not counted anywhere.
  addTask(db, "g", "claude");
  metric(db, PIVOT - 20 * DAY, "task.dispatched", "g", { target: "claude" });
  metric(db, PIVOT - 2 * DAY, STOPPED_ESCALATED_METRIC, "g", { item_id: "qg" });

  const rate = stoppedRunRate(db, { now: NOW, pivot_ms: PIVOT, days: 14 });
  assert.deepEqual(rate.before, { start_ms: PIVOT - 14 * DAY, end_ms: PIVOT });
  assert.deepEqual(rate.after, { start_ms: PIVOT, end_ms: PIVOT + 14 * DAY });
  const byHarness = Object.fromEntries(rate.by_harness.map((r) => [r.harness, r]));
  assert.deepEqual(byHarness.codex.before, { dispatches: 2, escalations: 1, rate: 0.5 });
  assert.deepEqual(byHarness.codex.after, { dispatches: 1, escalations: 2, rate: 2 });
  assert.deepEqual(byHarness.claude.before, { dispatches: 2, escalations: 2, rate: 1 });
  assert.deepEqual(byHarness.claude.after, { dispatches: 1, escalations: 0, rate: 0 });
  assert.equal(byHarness.pi, undefined, "the harness is the dispatch's, not the task's current target");
  assert.deepEqual(rate.total.before, { dispatches: 4, escalations: 3, rate: 0.75 });
  assert.deepEqual(rate.total.after, { dispatches: 2, escalations: 2, rate: 1 });
  assert.deepEqual(rate.sources, { marker: 3, capture_event: 1, title: 1 });
  db.close();
});

test("stopped-run rate: the after window stops at now and an empty window has no rate", () => {
  const db = new Db(":memory:");
  const rate = stoppedRunRate(db, { now: PIVOT + DAY, pivot_ms: PIVOT, days: 7 });
  assert.equal(rate.after.end_ms, PIVOT + DAY);
  assert.deepEqual(rate.total.after, { dispatches: 0, escalations: 0, rate: null });
  assert.deepEqual(rate.by_harness, []);
  // Before corral#126 a stopped run left no item: the window starts no earlier.
  const early = stoppedRunRate(db, { now: NOW, pivot_ms: STOPPED_DETECTION_START_MS + 3 * DAY, days: 14 });
  assert.equal(early.before.start_ms, STOPPED_DETECTION_START_MS);
  const ancient = stoppedRunRate(db, { now: NOW, pivot_ms: STOPPED_DETECTION_START_MS - 30 * DAY, days: 14 });
  assert.equal(ancient.before.start_ms, ancient.before.end_ms, "an empty window, not a negative one");
  assert.equal(ancient.after.start_ms, ancient.after.end_ms);
  db.close();
});
