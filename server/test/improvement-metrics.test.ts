import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { STOPPED_DETECTION_START_MS, prWaitSplit, stoppedRunRate } from "../improvement-metrics.ts";
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

function addPrItem(db: Db, id: string, taskId: string, over: Partial<Item> = {}): void {
  db.insertItem({
    id, kind: "pr", status: "open", title: "PR", summary: "", body: "", context: "", options: null, ready: 1,
    source_ref: null, task_id: taskId, structured: 1, created_ms: NOW - 10 * DAY, updated_ms: NOW - 10 * DAY,
    resolved_ms: null, snooze_until_ms: null, ...over,
  } as Item);
}

test("PR wait split: agent time to first ready, reviewer time to resolution, per repo", () => {
  const db = new Db(":memory:");
  const H = 3_600_000;
  const at = (offsetH: number) => NOW - 10 * DAY + offsetH * H;
  const repoTask = (id: string, repo: string, kind?: string) => {
    addTask(db, id, "claude");
    db.raw.prepare("UPDATE tasks SET repo_path = ?, kind = ? WHERE id = ?").run(repo, kind ?? "code", id);
  };

  // app: dispatched twice, ready twice; only the first of each counts.
  repoTask("p1", "/repos/app");
  metric(db, at(0), "task.dispatched", "p1", { target: "claude" });
  metric(db, at(5), "task.dispatched", "p1", { target: "claude" });
  addPrItem(db, "pr1", "p1", { status: "archived", created_ms: at(1), resolved_ms: at(26) });
  metric(db, at(2), "item.ready_for_review", "pr1", { task_id: "p1" });
  metric(db, at(6), "item.ready_for_review", "pr1", { task_id: "p1" });
  // app: found ready at creation; resolved without a timestamp, so the event is used.
  repoTask("p2", "/repos/app");
  metric(db, at(0), "task.dispatched", "p2", {});
  addPrItem(db, "pr2", "p2", { status: "resolved", created_ms: at(4) });
  metric(db, at(4), "item.created", "pr2", { kind: "pr", capture: "pr-sync", task_id: "p2", ready: 1 });
  metric(db, at(14), "item.resolved", "pr2", { how: "auto" });
  // A second PR item on p2 is ignored.
  addPrItem(db, "pr2b", "p2", { created_ms: at(8) });
  metric(db, at(9), "item.ready_for_review", "pr2b", {});
  // app: ready, still waiting for review.
  repoTask("p3", "/repos/app");
  metric(db, at(0), "task.dispatched", "p3", {});
  addPrItem(db, "pr3", "p3", { created_ms: at(1) });
  metric(db, at(3), "item.ready_for_review", "pr3", {});
  // engine: never ready.
  repoTask("p4", "/repos/engine");
  metric(db, at(0), "task.dispatched", "p4", {});
  addPrItem(db, "pr4", "p4", { ready: 0, created_ms: at(1) });
  // engine: found already merged, not a review wait.
  repoTask("p5", "/repos/engine");
  metric(db, at(0), "task.dispatched", "p5", {});
  addPrItem(db, "pr5", "p5", { status: "archived", created_ms: at(2), resolved_ms: at(2) });
  metric(db, at(2), "item.created", "pr5", { kind: "pr", task_id: "p5", ready: 1 });
  // engine: needed work until merged; pr.ts fires ready at the merge itself.
  repoTask("p8", "/repos/engine");
  metric(db, at(0), "task.dispatched", "p8", {});
  addPrItem(db, "pr8", "p8", { status: "archived", ready: 1, created_ms: at(1), resolved_ms: at(40) });
  metric(db, at(40) + 3, "item.ready_for_review", "pr8", { task_id: "p8" });
  // A review task: the PR is not the agent's.
  repoTask("p6", "/repos/app", "review");
  metric(db, at(0), "task.dispatched", "p6", {});
  addPrItem(db, "pr6", "p6", { created_ms: at(1) });
  metric(db, at(1), "item.ready_for_review", "pr6", {});
  // Ready before the window.
  repoTask("p7", "/repos/app");
  addPrItem(db, "pr7", "p7", { created_ms: NOW - 40 * DAY });
  metric(db, NOW - 40 * DAY, "item.ready_for_review", "pr7", {});

  const split = prWaitSplit(db, { now: NOW, days: 30 });
  assert.equal(split.never_ready, 1);
  assert.equal(split.resolved_without_ready, 2, "found merged and merged before ready");
  assert.deepEqual(split.by_repo.map((r) => r.repo), ["/repos/app"]);
  const app = split.by_repo[0];
  assert.equal(app.prs, 3);
  assert.deepEqual(app.agent, { count: 3, p50_ms: 3 * H, p90_ms: 4 * H });
  assert.deepEqual(app.reviewer, { count: 2, p50_ms: 10 * H, p90_ms: 24 * H });
  assert.equal(app.awaiting_review, 1);
  assert.deepEqual(split.total.agent, app.agent);
  db.close();
});
