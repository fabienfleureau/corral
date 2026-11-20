// Terminal tasks must release their worktree and branch without breaking the
// PR loop, which still needs the branch while an item is open.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { CaptureEngine } from "../capture.ts";
import { syncTaskPr, type PrInfo } from "../pr.ts";
import { cleanupFinishedTask, cleanupTerminalWorktrees } from "../worktree-cleanup.ts";
import type { WorkerBackend } from "../worker.ts";
import type { Item, Task } from "../types.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1",
    title: "Add caching",
    prompt: "Add caching",
    repo_path: "/tmp/repo",
    target: "claude",
    target_state: "suggested",
    base_branch: null,
    branch: "corral/add-caching-task-1",
    worktree_path: "/tmp/repo-worktrees/corral/add-caching-task-1",
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: null,
    pr_meta: null,
    status: "done",
    terminal_address: "s1",
    exit_code: 0,
    handoff: null,
    created_ms: now,
    updated_ms: now,
    ...over,
  };
}

function makePrItem(over: Partial<Item> = {}): Item {
  const now = Date.now();
  return {
    id: "item-1",
    kind: "pr",
    status: "open",
    title: "PR needs work: add caching",
    summary: "ready",
    body: "PR: https://example.com/pr/7",
    context: "",
    options: null,
    ready: 0,
    handling: 0,
    source_ref: "s1",
    task_id: "task-1",
    structured: 1,
    created_ms: now,
    updated_ms: now,
    resolved_ms: null,
    snooze_until_ms: null,
    ...over,
  };
}

function fakeBackend() {
  const cleaned: string[] = [];
  const archived: string[] = [];
  const backend: WorkerBackend = {
    name: "fake",
    start: async () => { throw new Error("not used"); },
    list: async () => [],
    get: async () => null,
    read: async () => "",
    send: async () => undefined,
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    archive: async (address) => { archived.push(address); },
    cleanup: async (address) => { cleaned.push(address); },
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop() {} }),
  };
  return { backend, cleaned, archived };
}

test("cleanup a finished task keeps its branch record and reports the removal", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask());
    const { backend, cleaned } = fakeBackend();
    const broadcasts: [string, unknown][] = [];
    const hub = { broadcast: (type: string, data: unknown) => broadcasts.push([type, data]) };
    assert.equal(await cleanupFinishedTask(db, backend, "task-1", { hub, reason: "done-report" }), true);
    assert.deepEqual(cleaned, ["s1"]);
    const task = db.getTask("task-1")!;
    assert.equal(task.worktree_path, null);
    assert.equal(task.branch, "corral/add-caching-task-1");
    assert.equal(task.status, "done");
    assert.ok(broadcasts.some(([type]) => type === "task.updated"));
    assert.ok(db.recentMetrics().some((m) => m.name === "task.worktree_removed"));
    assert.match(db.listTaskEvents("task-1").at(-1)!.message, /Worktree removed/);
    // A second call does not delete the session twice.
    assert.equal(await cleanupFinishedTask(db, backend, "task-1"), false);
  } finally { db.close(); }
});

test("an open PR keeps its worktree until the item closes", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask());
    db.insertItem(makePrItem());
    const { backend, cleaned } = fakeBackend();
    assert.equal(await cleanupFinishedTask(db, backend, "task-1"), false);
    assert.deepEqual(cleaned, []);
    assert.equal(db.getTask("task-1")?.worktree_path, "/tmp/repo-worktrees/corral/add-caching-task-1");
    db.updateItem("item-1", { status: "archived" });
    assert.equal(await cleanupTerminalWorktrees(db, backend), 1);
    assert.deepEqual(cleaned, ["s1"]);
    assert.equal(db.getTask("task-1")?.worktree_path, null);
  } finally { db.close(); }
});

test("a failed removal leaves the worktree for a later sweep", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask());
    const { backend, cleaned } = fakeBackend();
    let fail = true;
    backend.cleanup = async (address) => { if (fail) throw new Error("backend down"); cleaned.push(address); };
    assert.equal(await cleanupFinishedTask(db, backend, "task-1"), false);
    assert.equal(db.getTask("task-1")?.worktree_path, "/tmp/repo-worktrees/corral/add-caching-task-1");
    fail = false;
    assert.equal(await cleanupTerminalWorktrees(db, backend), 1);
    assert.deepEqual(cleaned, ["s1"]);
  } finally { db.close(); }
});

test("an archived task with an open PR is swept only after the PR resolves", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ status: "archived" }));
    db.insertItem(makePrItem());
    const { backend, cleaned } = fakeBackend();
    assert.equal(await cleanupTerminalWorktrees(db, backend), 0);
    db.updateItem("item-1", { status: "resolved", resolved_ms: Date.now() });
    assert.equal(await cleanupTerminalWorktrees(db, backend), 1);
    assert.deepEqual(cleaned, ["s1"]);
  } finally { db.close(); }
});

async function post(server: ReturnType<typeof createHttpServer>, path: string, token = "test") {
  const port = (server.address() as { port: number }).port;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function serve(db: Db, backend: WorkerBackend, hub: { broadcast: (type: string, data: unknown) => void }) {
  const server = createHttpServer({ db, backend, hub, cfg: { token: "test" } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("archive-session archives the session, then removes its worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-cleanup-archive-"));
  const db = new Db(join(dir, "test.db"));
  db.insertTask(makeTask({ status: "dispatched" }));
  const { backend, cleaned, archived } = fakeBackend();
  const server = await serve(db, backend, { broadcast() {} });
  try {
    const res = await post(server, "/api/tasks/task-1/archive-session");
    assert.equal(res.status, 200);
    assert.deepEqual(archived, ["s1"]);
    assert.deepEqual(cleaned, ["s1"]);
    const task = await res.json() as Task;
    assert.equal(task.status, "archived");
    assert.equal(task.worktree_path, null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed session archive does not remove the worktree", async () => {
  const db = new Db(":memory:");
  db.insertTask(makeTask({ status: "dispatched" }));
  const { backend, cleaned } = fakeBackend();
  backend.archive = async () => { throw new Error("unavailable"); };
  const server = await serve(db, backend, { broadcast() {} });
  try {
    assert.equal((await post(server, "/api/tasks/task-1/archive-session")).status, 500);
    assert.deepEqual(cleaned, []);
    assert.equal(db.getTask("task-1")?.status, "dispatched");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test("PATCH to a terminal status releases the worktree, other statuses do not", async () => {
  const db = new Db(":memory:");
  db.insertTask(makeTask({ status: "dispatched" }));
  const { backend, cleaned } = fakeBackend();
  const server = await serve(db, backend, { broadcast() {} });
  try {
    const port = (server.address() as { port: number }).port;
    const patch = (status: string) => fetch(`http://127.0.0.1:${port}/api/tasks/task-1`, {
      method: "PATCH",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    assert.equal((await patch("dispatched")).status, 200);
    assert.deepEqual(cleaned, []);
    assert.equal((await patch("done")).status, 200);
    assert.deepEqual(cleaned, ["s1"]);
    assert.equal(db.getTask("task-1")?.worktree_path, null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test("a session ending without a report releases the worktree", async () => {
  const db = new Db(":memory:");
  db.insertTask(makeTask({ status: "dispatched", branch: null }));
  const { backend, cleaned } = fakeBackend();
  const capture = new CaptureEngine(db, backend, { broadcast() {} });
  await capture.handleEvent({ type: "finished", address: "s1", task_id: "task-1", exit_code: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(db.getTask("task-1")?.status, "done");
  assert.deepEqual(cleaned, ["s1"]);
  assert.equal(db.getTask("task-1")?.worktree_path, null);
  db.close();
});

test("a completion report without a PR releases the worktree", async () => {
  const db = new Db(":memory:");
  db.insertTask(makeTask({ status: "dispatched", kind: "ops" }));
  const { backend, cleaned } = fakeBackend();
  const capture = new CaptureEngine(db, backend, { broadcast() {} });
  const item = await capture.createStructuredQuestion({
    kind: "done",
    taskId: "task-1",
    title: "Done",
    body: "Work finished in the folder.",
  });
  assert.equal(item.kind, "digest");
  // The report's cleanup is fire-and-forget; wait for the backend call.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(cleaned, ["s1"]);
  assert.equal(db.getTask("task-1")?.worktree_path, null);
  db.close();
});

test("a merged PR completes the task and removes the worktree", async () => {
  const db = new Db(":memory:");
  db.insertTask(makeTask({ status: "dispatched" }));
  const { backend, cleaned, archived } = fakeBackend();
  const merged: PrInfo = {
    url: "https://example.com/pr/7",
    title: "add caching",
    state: "MERGED",
    number: 7,
    description: "",
    additions: 1,
    deletions: 0,
    changed_files: 1,
    mergeable: "MERGEABLE",
    base_ref: "main",
    review_decision: null,
    checks: { total: 1, failed: 0, pending: false },
    threads: [],
  };
  const pr = await syncTaskPr(db, { broadcast() {} }, db.getTask("task-1")!, {
    backend,
    finder: () => merged,
  });
  assert.equal(pr?.state, "MERGED");
  assert.equal(db.getTask("task-1")?.status, "done");
  assert.equal(db.getTask("task-1")?.worktree_path, null);
  assert.deepEqual(cleaned, ["s1"]);
  assert.deepEqual(archived, ["s1"]);
  db.close();
});
