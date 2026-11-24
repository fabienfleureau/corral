// ADR 0022: a done report on a task with an open PR keeps the task in its
// status until the PR merges or closes, and the task records how it ended.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { CaptureEngine } from "../capture.ts";
import { syncTaskPr, type PrInfo } from "../pr.ts";
import type { Task } from "../types.ts";
import type { WorkerBackend } from "../worker.ts";

const URL = "https://github.com/acme/app/pull/7";
const hub = { broadcast() {} };

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Add caching", prompt: "Add caching", repo_path: "/tmp/repo", target: "claude",
    target_state: "suggested", base_branch: null, branch: "feat-x", worktree_path: null, assignee: null,
    jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null, status: "dispatched",
    terminal_address: "s1", exit_code: null, created_ms: now, updated_ms: now, ...over,
  };
}

function pr(state: string): PrInfo {
  return {
    url: URL, title: "Add caching", state, number: 7, description: "", additions: 1, deletions: 0,
    changed_files: 1, mergeable: "MERGEABLE", base_ref: "main", review_decision: null, human_approvals: null,
    checks: { total: 1, failed: 0, pending: true }, threads: [], threads_known: true,
  };
}

function setup(finder: () => PrInfo | null, task: Partial<Task> = {}) {
  const db = new Db(":memory:");
  db.insertTask(makeTask(task));
  db.upsertTerminal({ address: "s1", task_id: "task-1", name: null, agent: "claude", last_status: "working", last_turn: 0, updated_ms: Date.now() });
  const backend = {
    name: "fake",
    read: async () => "tail",
    send: async () => undefined,
    lastRunOutcome: async () => ({ kind: "message", text: "Done." }),
  } as unknown as WorkerBackend;
  const capture = new CaptureEngine(db, backend, hub, null, null, {
    stoppedRetry: { maxAttempts: 0, silentStopAttempts: 0 },
    prFinder: finder,
  });
  return { db, capture };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "condition reached");
}

const report = { kind: "done", taskId: "task-1", terminal: "s1", title: "PR: add caching", body: `Done.\n\nPR: ${URL}` };

test("a done report with an open PR keeps the task dispatched, even after the session ends", async () => {
  let state = "OPEN";
  const { db, capture } = setup(() => pr(state));
  try {
    await capture.createStructuredQuestion(report);
    await until(() => db.getTask("task-1")?.pr_url === URL);
    assert.equal(db.getTask("task-1")?.status, "dispatched");
    assert.equal(db.getTask("task-1")?.outcome ?? null, null);

    await capture.handleEvent({ type: "finished", address: "s1", task_id: "task-1", exit_code: 0 });
    assert.equal(db.getTask("task-1")?.status, "dispatched", "the session ending does not complete it either");

    // An idle session on a held task asks nothing: its PR item is open.
    await capture.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "idle" });
    assert.equal(db.listItems({ kind: "question", status: "open" }).length, 0);

    state = "MERGED";
    await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr(state) });
    assert.equal(db.getTask("task-1")?.status, "done");
    assert.equal(db.getTask("task-1")?.outcome, "merged");
  } finally { db.close(); }
});

test("a done report whose PR closed unmerged completes the task as closed", async () => {
  const { db, capture } = setup(() => pr("CLOSED"));
  try {
    await capture.createStructuredQuestion(report);
    await until(() => db.getTask("task-1")?.status === "done");
    assert.equal(db.getTask("task-1")?.outcome, "closed");
  } finally { db.close(); }
});

test("a done report with no PR to find completes the task as reported", async () => {
  const { db, capture } = setup(() => null, { branch: null });
  try {
    await capture.createStructuredQuestion({ ...report, body: "Done." });
    await until(() => db.getTask("task-1")?.status === "done");
    assert.equal(db.getTask("task-1")?.outcome, "reported");
  } finally { db.close(); }
});

test("an ops task's done report completes it as reported, without a PR lookup", async () => {
  let looked = false;
  const { db, capture } = setup(() => { looked = true; return null; }, { kind: "ops", branch: null });
  try {
    const item = await capture.createStructuredQuestion({ ...report, body: "Done." });
    assert.equal(item.kind, "digest");
    assert.equal(db.getTask("task-1")?.status, "done");
    assert.equal(db.getTask("task-1")?.outcome, "reported");
    assert.equal(looked, false);
  } finally { db.close(); }
});

test("a grill task's done report linking its repo's PR completes it as reported", async () => {
  // linkReportedPr adopts the PR, but the PR loop does not follow grill
  // tasks: nothing would ever settle a hold, so the task completes now.
  const dir = mkdtempSync(join(tmpdir(), "corral-outcome-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/app.git"]);
  let looked = false;
  const { db, capture } = setup(() => { looked = true; return pr("OPEN"); }, { kind: "grill", branch: null, repo_path: dir });
  try {
    const item = await capture.createStructuredQuestion({ ...report, body: `Interview done, docs PR opened: ${URL}` });
    assert.equal(item.kind, "digest");
    assert.equal(db.getTask("task-1")?.pr_url, URL);
    assert.equal(db.getTask("task-1")?.status, "done");
    assert.equal(db.getTask("task-1")?.outcome, "reported");
    await capture.handleEvent({ type: "finished", address: "s1", task_id: "task-1", exit_code: 0 });
    assert.equal(db.getTask("task-1")?.status, "done");
    assert.equal(looked, false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a second done report on a held task logs no second ready event for the same commit", async () => {
  const ready = (): PrInfo => ({ ...pr("OPEN"), head_sha: "abc", checks: { total: 1, failed: 0, pending: false } });
  const { db, capture } = setup(ready);
  const events = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM metrics_events WHERE name = 'item.ready_for_review'").get() as { n: number }).n;
  try {
    await capture.createStructuredQuestion(report);
    await until(() => events() === 1);
    await capture.createStructuredQuestion({ ...report, title: "PR: add caching (again)" });
    await until(() => db.listItems({ kind: "pr" })[0]?.ready === 1);
    assert.equal(events(), 1);
    assert.equal(db.getTask("task-1")?.status, "dispatched");
    assert.equal(db.getTask("task-1")?.outcome ?? null, null);
  } finally { db.close(); }
});

test("a task already done whose PR closes records the closed outcome", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ status: "done", pr_url: URL }));
    await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr("CLOSED") });
    assert.equal(db.getTask("task-1")?.outcome, "closed");
  } finally { db.close(); }
});

test("a closed PR does not complete a task the agent is still working on", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ pr_url: URL }));
    await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr("CLOSED") });
    assert.equal(db.getTask("task-1")?.status, "dispatched");
    assert.equal(db.getTask("task-1")?.outcome ?? null, null);
  } finally { db.close(); }
});

test("reopening a task clears its outcome", () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ status: "done" }));
    db.updateTask("task-1", { outcome: "merged" });
    db.updateTask("task-1", { status: "dispatched" });
    assert.equal(db.getTask("task-1")?.outcome, null);
  } finally { db.close(); }
});
