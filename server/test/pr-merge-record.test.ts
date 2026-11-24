// A merge records when it happened and how ready the PR looked just before,
// so "merged before green" is measurable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { syncTaskPr, type PrInfo } from "../pr.ts";
import { collectImprovementEvidence } from "../improvement-evidence.ts";
import type { MergeReadiness, Task } from "../types.ts";

const URL = "https://github.com/acme/app/pull/7";
const hub = { broadcast: () => undefined };

function task(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Add caching", prompt: "", repo_path: "/tmp/repo", target: "claude", target_state: "suggested",
    base_branch: null, branch: "feat-x", worktree_path: null, assignee: null, jira_key: null, jira_url: null,
    jira_parent_key: null, pr_url: URL, pr_meta: null, status: "done", terminal_address: null, exit_code: null,
    created_ms: now, updated_ms: now, ...over,
  };
}

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    url: URL, title: "Add caching", state: "OPEN", number: 7, description: "", additions: 1, deletions: 0,
    changed_files: 1, mergeable: "MERGEABLE", base_ref: "main", review_decision: null, human_approvals: null,
    checks: { total: 2, failed: 0, pending: false }, threads: [], threads_known: true, ...over,
  };
}

function readiness(t: Task | null): MergeReadiness | null {
  return t?.merge_readiness ? (JSON.parse(t.merge_readiness) as MergeReadiness) : null;
}

test("a merge records the platform merge time and the last open gate state", async () => {
  const db = new Db(":memory:");
  db.insertTask(task());
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => pr({ checks: { total: 2, failed: 1, pending: true }, threads: [{ id: "th1", author: "bot", body: "nit" }] }),
  });
  const mergedAt = Date.parse("2026-11-20T10:00:00Z");
  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr({ state: "MERGED", merged_ms: mergedAt }) });

  const t = db.getTask("task-1");
  assert.equal(t?.merged_ms, mergedAt);
  const r = readiness(t);
  assert.equal(r?.ready, false);
  assert.equal(r?.failing_checks, 1);
  assert.equal(r?.pending_checks, true);
  assert.equal(r?.unresolved_threads, 1);
  assert.ok(r?.reasons.includes("1 failing check"));
  const events = db.raw.prepare("SELECT data FROM metrics_events WHERE name = 'pr.merged'").all() as { data: string }[];
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].data).ready, false);
  db.close();
});

test("a merge seen on the first sync records detection time and unknown readiness", async () => {
  const db = new Db(":memory:");
  db.insertTask(task({ status: "dispatched" }));
  const before = Date.now();
  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr({ state: "MERGED" }) });

  const t = db.getTask("task-1");
  assert.ok((t?.merged_ms ?? 0) >= before);
  assert.equal(t?.merge_readiness, null);
  assert.equal(t?.status, "done");
  db.close();
});

test("the merge is recorded once", async () => {
  const db = new Db(":memory:");
  db.insertTask(task());
  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr() });
  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr({ state: "MERGED", merged_ms: 1000 }) });
  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr({ state: "MERGED", merged_ms: 2000 }) });

  const t = db.getTask("task-1");
  assert.equal(t?.merged_ms, 1000);
  assert.equal(readiness(t)?.ready, true);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM metrics_events WHERE name = 'pr.merged'").get() as { n: number }).n, 1);
  db.close();
});

test("improvement evidence counts merges that were not ready", async () => {
  const db = new Db(":memory:");
  const notReady: MergeReadiness = { ready: false, reasons: ["checks still running"], failing_checks: 0, pending_checks: true, unresolved_threads: 0, review_decision: null, checked_ms: 1 };
  const ready: MergeReadiness = { ...notReady, ready: true, reasons: [], pending_checks: false };
  db.insertTask(task({ id: "a" }));
  db.insertTask(task({ id: "b" }));
  db.insertTask(task({ id: "c" }));
  db.insertTask(task({ id: "d" }));
  db.updateTask("a", { merged_ms: 10, merge_readiness: JSON.stringify(notReady) });
  db.updateTask("b", { merged_ms: 10, merge_readiness: JSON.stringify(ready) });
  db.updateTask("c", { merged_ms: 10, merge_readiness: null });

  const evidence = collectImprovementEvidence(db);
  assert.deepEqual(evidence.merges, { total: 3, ready: 1, not_ready: 1, unknown: 1, not_ready_task_ids: ["a"] });
  const a = evidence.tasks.find((t) => t.id === "a");
  assert.equal(a?.merge_readiness?.ready, false);
  assert.ok(a?.flags.includes("merged_before_ready"));
  assert.equal(evidence.tasks.find((t) => t.id === "d")?.merged_ms, null);
  db.close();
});
