import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { collectImprovementEvidence } from "../improvement-evidence.ts";
import { buildUsageEvidence, type UsageRecord } from "../usage.ts";
import type { Item, Task } from "../types.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function task(over: Partial<Task>): Task {
  return {
    id: "t1",
    title: "A task",
    prompt: "A task",
    repo_path: "/repos/app",
    target: "claude",
    target_state: "confirmed",
    base_branch: "main",
    branch: "feat/x",
    worktree_path: null,
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: null,
    pr_meta: null,
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: NOW - DAY,
    updated_ms: NOW - DAY,
    ...over,
  } as Task;
}

function item(over: Partial<Item>): Item {
  return {
    id: "i1",
    kind: "question",
    status: "open",
    title: "A question",
    summary: "",
    body: "",
    context: "",
    options: null,
    ready: 1,
    source_ref: null,
    task_id: null,
    structured: 0,
    created_ms: NOW - DAY,
    updated_ms: NOW - DAY,
    resolved_ms: null,
    snooze_until_ms: null,
    ...over,
  } as Item;
}

test("improvement evidence: joins tasks outside the recent window and flags record drift", () => {
  const db = new Db(":memory:");
  try {
    // t1 is recent but untitled and done without a PR. t2 is old and only
    // reachable through an item. t3 is old and only reachable through an event.
    db.insertTask(task({ id: "t1", title: "", model: null, status: "done", pr_url: null, updated_ms: NOW - 3_600_000 }));
    db.insertTask(task({ id: "t2", title: "Old delivered work", status: "archived", updated_ms: NOW - 60 * DAY, pr_url: "https://example.com/pr/2" }));
    db.insertTask(task({ id: "t3", title: "Old review", status: "archived", updated_ms: NOW - 45 * DAY }));
    db.insertTask(task({ id: "t4", title: "Newest", updated_ms: NOW - 60_000 }));

    db.insertItem(item({ id: "i-pr", kind: "pr", status: "open", task_id: "t2", created_ms: NOW - 2 * DAY }));
    db.insertItem(item({ id: "i-dup", kind: "pr", status: "open", task_id: "t1", created_ms: NOW - DAY }));
    db.insertItem(item({ id: "i-dup-2", kind: "pr", status: "archived", task_id: "t1", created_ms: NOW - 2 * DAY }));
    db.insertItem(item({
      id: "i-resolved",
      kind: "question",
      status: "resolved",
      task_id: "t1",
      created_ms: NOW - 3 * DAY,
      resolved_ms: null,
    }));
    db.insertItem(item({ id: "i-malformed", kind: "question", status: "open", task_id: " t2", created_ms: NOW - DAY }));

    const metric = (ts: number, name: string, ref: string, data: unknown = null): void => {
      db.raw.prepare("INSERT INTO metrics_events (ts, name, ref, data) VALUES (?, ?, ?, ?)").run(ts, name, ref, data === null ? null : JSON.stringify(data));
    };
    metric(NOW - 5 * 3_600_000, "task.dispatched", "t1", { target: "claude", address: "a" });
    metric(NOW - 2 * 3_600_000, "task.dispatched", "t1", { target: "claude", address: "b" });
    metric(NOW - 4 * 3_600_000, "task.dispatched", "t3", { target: "codex" });
    metric(NOW - 2 * DAY, "item.created", "i-resolved", { kind: "question" });
    metric(NOW - DAY, "item.resolved", "i-resolved", { how: "auto" });
    metric(NOW - 30 * 60_000, "item.ready_for_review", "i-dup", { task_id: "t1" });

    const evidence = collectImprovementEvidence(db, { now: NOW, taskLimit: 1, itemLimit: 20, eventLimit: 50 });
    const byId = new Map(evidence.tasks.map((t) => [t.id, t]));

    assert.deepEqual(evidence.tasks.map((t) => t.id).sort(), ["t1", "t2", "t3", "t4"]);
    assert.equal(evidence.truncated.tasks, true, "the recent task window is capped");
    assert.equal(byId.get("t2")?.label, "Old delivered work");
    assert.equal(byId.get("t1")?.dispatches.count, 2);
    assert.ok((byId.get("t1")?.dispatches.gaps_ms[0] ?? 0) > 0);
    assert.equal(byId.get("t3")?.dispatches.count, 1, "an event-only task is kept");
    assert.ok(byId.get("t1")?.flags.includes("untitled"));
    assert.ok(byId.get("t1")?.flags.includes("done_without_pr"));
    assert.ok(byId.get("t2")?.flags.includes("no_pr_snapshot"));

    const resolved = evidence.items.find((i) => i.id === "i-resolved");
    assert.ok(resolved?.flags.includes("resolved_without_timestamp"));
    assert.equal(resolved?.task?.in_task_window, false, "t1 is linked through its items after the window cap")

    const outside = evidence.items.find((i) => i.id === "i-pr");
    assert.equal(outside?.task?.in_task_window, false);
    assert.ok(outside?.flags.includes("outside_task_window"));

    const malformed = evidence.items.find((i) => i.id === "i-malformed");
    assert.ok(malformed?.flags.includes("malformed_task_id"));
    assert.ok(malformed?.flags.includes("orphan_task"));

    assert.deepEqual(evidence.data_quality.untitled_tasks, ["t1"]);
    assert.deepEqual(evidence.data_quality.done_without_pr, ["t1"]);
    assert.deepEqual(evidence.data_quality.resolved_without_timestamp, [{ item_id: "i-resolved", resolved_event_ms: NOW - DAY }]);
    assert.deepEqual(evidence.data_quality.duplicate_pr_items, [{ task_id: "t1", item_ids: ["i-dup", "i-dup-2"] }]);
    assert.equal(evidence.data_quality.items_outside_task_window, 4, "every item linked to a task outside the window is counted");
    assert.ok(evidence.data_quality.malformed_task_ids.some((m) => m.item_id === "i-malformed"));
    assert.ok(evidence.events.some((e) => e.name === "task.dispatched" && JSON.stringify(e.data).includes("codex")));
  } finally {
    db.close();
  }
});

test("improvement evidence: items snoozed twice or more are counted", () => {
  const db = new Db(":memory:");
  try {
    db.insertItem(item({ id: "i-twice", kind: "question", created_ms: NOW - 4 * DAY }));
    db.insertItem(item({ id: "i-once", kind: "pr" }));
    db.snoozeItem("i-twice", NOW + 3_600_000);
    db.snoozeItem("i-twice", NOW + 7_200_000);
    db.snoozeItem("i-once", NOW + 3_600_000);

    const evidence = collectImprovementEvidence(db, { now: NOW });
    assert.ok(evidence.items.find((i) => i.id === "i-twice")?.flags.includes("snoozed_repeatedly"));
    assert.equal(evidence.items.find((i) => i.id === "i-once")?.snooze_count, 1);
    assert.deepEqual(evidence.data_quality.repeatedly_snoozed_items, {
      count: 1,
      items: [{ item_id: "i-twice", kind: "question", status: "open", snoozes: 2, age_ms: 4 * DAY }],
    });
  } finally {
    db.close();
  }
});

test("improvement evidence: usage costs and the models actually used attach to tasks", () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(task({ id: "t1", worktree_path: "/work/t1" }));
    const records: UsageRecord[] = [{
      agent: "claude",
      key: "k1",
      ts: NOW - 3_600_000,
      model: "claude-opus-5",
      cwd: "/work/t1/sub",
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    }];
    const usage = buildUsageEvidence({
      records,
      tasks: db.listTasks(),
      prices: { "claude-opus-5": { input: 5, output: 25 } },
      since_ms: NOW - 30 * DAY,
      now: NOW,
    });
    const evidence = collectImprovementEvidence(db, { now: NOW, usage });
    const taskEvidence = evidence.tasks.find((t) => t.id === "t1");
    assert.equal(evidence.usage?.attributed_usd, 5);
    assert.equal(taskEvidence?.usage?.cost_usd, 5);
    assert.deepEqual(taskEvidence?.usage?.models, ["claude-opus-5"]);
    assert.equal(taskEvidence?.model, null, "the pinned model can stay blank while usage shows the real one");
    assert.ok(taskEvidence?.flags.includes("no_pinned_model"));
  } finally {
    db.close();
  }
});

test("improvement evidence: the PR loop snapshot is exposed with checks and threads", () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(task({
      id: "t1",
      pr_url: "https://example.com/pr/1",
      pr_meta: JSON.stringify({
        pr: {
          url: "https://example.com/pr/1",
          state: "OPEN",
          mergeable: "CONFLICTING",
          checks: { total: 3, failed: 1, pending: false },
          threads: { unresolved: 2, ids: ["th1", "th2"], known: true },
          ready: false,
          reasons: ["2 unresolved review comments", "1 failing check", "merge conflicts"],
          review_decision: "CHANGES_REQUESTED",
          base_ref: "main",
          checked_ms: NOW - 60_000,
        },
      }),
    }));
    const evidence = collectImprovementEvidence(db, { now: NOW });
    const t = evidence.tasks[0];
    assert.equal(t.pr?.checks.failed, 1);
    assert.equal(t.pr?.threads.unresolved, 2);
    assert.deepEqual(t.pr?.reasons, ["2 unresolved review comments", "1 failing check", "merge conflicts"]);
    assert.ok(!t.flags.includes("no_pr_snapshot"));
  } finally {
    db.close();
  }
});
