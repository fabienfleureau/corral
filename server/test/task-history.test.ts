// Task history: the log an inbox modal reads, and the events that must land in
// it — creation, field edits, status changes, prompts sent to the agent, Jira
// moves, PR milestones. History is a fact log, so it never breaks the write it
// documents.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { logTaskChanges, logTaskEvent, oneLine, promptData, PROMPT_PREVIEW_CHARS } from "../task-events.ts";
import { syncTaskPr, type PrInfo } from "../pr.ts";
import { CaptureEngine } from "../capture.ts";
import type { WorkerBackend, WorkerSession, WorkerStart } from "../worker.ts";
import type { Task } from "../types.ts";
import type { TaskEvent } from "../task-events.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Add caching", prompt: "Add caching", kind: "code", repo_path: "/tmp/repo",
    target: "claude", target_state: "suggested", base_branch: null, branch: null, worktree_path: null,
    assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null,
    status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now, ...over,
  };
}

function withDb(fn: (db: Db) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-task-history-"));
    const db = new Db(join(dir, "test.db"));
    try {
      await fn(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const kinds = (events: TaskEvent[]) => events.map((e) => e.kind);
const messages = (events: TaskEvent[]) => events.map((e) => e.message);
const dataOf = (event: TaskEvent | undefined) => (event?.data ? JSON.parse(event.data) as Record<string, unknown> : {});

function fakeBackend(): { backend: WorkerBackend } {
  const session: WorkerSession = {
    address: "s1", task_id: "task-1", name: null, harness: "claude", status: "working", blocked_kind: null,
    state: "live", turn: 1, cwd: "/tmp/repo", created_ms: Date.now(), exit_code: null, parent: null,
  };
  const backend = {
    name: "fake",
    async start(_s: WorkerStart) { return session; },
    list: async () => [],
    get: async () => session,
    read: async () => "",
    send: async () => undefined,
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop: () => undefined }),
  } as WorkerBackend;
  return { backend };
}

// ---- the log itself ----

test("logTaskEvent keeps one readable line and drops empty fields", withDb((db) => {
  logTaskEvent(db, "task-1", "updated", "Title:   two\nlines   of title", { from: null, to: "x", empty: "", missing: undefined });
  const [event] = db.listTaskEvents("task-1");
  assert.equal(event.kind, "updated");
  assert.equal(event.message, "Title: two lines of title", "whitespace collapses: one event is one line");
  assert.deepEqual(JSON.parse(event.data ?? "{}"), { to: "x" }, "null/empty detail values carry no information");
}));

test("oneLine clips long text and promptData always keeps the size", () => {
  assert.equal(oneLine("x".repeat(200)).length, 120);
  assert.match(oneLine("x".repeat(200)), /…$/);
  const short = promptData("hello", { source: "reply" });
  assert.equal(short.text, "hello");
  assert.equal(short.chars, 5);
  const long = promptData("y".repeat(PROMPT_PREVIEW_CHARS + 10));
  assert.equal(String(long.text).length, PROMPT_PREVIEW_CHARS + "\n…(2010 chars)".length);
  assert.equal(long.chars, PROMPT_PREVIEW_CHARS + 10);
});

test("a broken store never breaks the write the history documents", () => {
  const store = { insertTaskEvent() { throw new Error("disk on fire"); } };
  assert.doesNotThrow(() => logTaskEvent(store, "task-1", "created", "Task created"));
});

test("updateTask records the changes worth a history line, and only those", withDb((db) => {
  db.insertTask(makeTask({ status: "open" }));
  db.updateTask("task-1", { status: "dispatched", branch: "feat/x", pr_meta: JSON.stringify({ pushed: "abc" }) });

  const events = db.listTaskEvents("task-1");
  assert.deepEqual(messages(events), ["Status: open → dispatched", "Branch: feat/x"]);
  assert.deepEqual(kinds(events), ["status", "updated"]);
  assert.deepEqual(JSON.parse(events[0].data ?? "{}"), { from: "open", to: "dispatched" });

  // Same value again: nothing happened, so nothing is recorded.
  db.updateTask("task-1", { status: "dispatched" });
  assert.equal(db.listTaskEvents("task-1").length, 2);
}));

test("taskChanges covers the lifecycle fields a human wants to trace", () => {
  const before = makeTask({ status: "dispatched", jira_status: "In Progress", pr_url: null, model: "sonnet" });
  const changes = logChangesFor(before, {
    status: "done", jira_status: "Done", pr_url: "https://github.com/o/r/pull/1",
    exit_code: 0, model: "opus", branch: "feat/x",
  });
  assert.equal(changes, 6, "status, jira, pr, exit code, model and branch");
  const withWorktree = makeTask({ worktree_path: "/tmp/wt" });
  assert.equal(logChangesFor(withWorktree, { worktree_path: null }), 1, "removing a worktree is an event");
});

/** Count the changes taskChanges finds for a patch (assertion helper: the
 *  function itself only returns data). */
function logChangesFor(before: Task, patch: Partial<Task>): number {
  const dir = mkdtempSync(join(tmpdir(), "corral-task-history-"));
  const db = new Db(join(dir, "test.db"));
  try {
    logTaskChanges(db, before, patch);
    return db.listTaskEvents(before.id).length;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the list keeps the most recent events, in reading order", withDb((db) => {
  for (let i = 1; i <= 5; i++) {
    db.insertTaskEvent({ task_id: "task-1", ts: 1000 + i, kind: "status", message: `step ${i}`, data: null });
  }
  assert.deepEqual(messages(db.listTaskEvents("task-1")), ["step 1", "step 2", "step 3", "step 4", "step 5"]);
  assert.deepEqual(messages(db.listTaskEvents("task-1", 2)), ["step 4", "step 5"], "a capped history keeps the tail");
  db.insertTaskEvent({ task_id: "task-2", ts: 1, kind: "created", message: "other task", data: null });
  assert.equal(db.listTaskEvents("task-1").length, 5, "histories do not leak across tasks");
}));

test("a pre-existing task gets its creation backfilled once", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-task-history-"));
  const path = join(dir, "test.db");
  try {
    const first = new Db(path);
    first.insertTask(makeTask({ created_ms: 1234 }));
    first.close();
    // Re-opening runs the migration: the single fact the row still knows.
    const second = new Db(path);
    const events = second.listTaskEvents("task-1");
    second.close();
    assert.deepEqual(messages(events), ["Task created (history starts here)"]);
    assert.equal(events[0].ts, 1234, "the task's own creation time, not the migration time");
    assert.equal(dataOf(events[0]).backfilled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the events recorded by the lifecycle ----

test("a dispatch records the prompt it sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-task-history-"));
  const db = new Db(join(dir, "test.db"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    const { backend } = fakeBackend();
    const cfg = { token: "t", configDir: "/nonexistent", host: "127.0.0.1", port: 4787, agents: { claude: {} }, jira: null, reviewers: [] } as never;
    db.insertTask(makeTask({ repo_path: dir }));
    const { dispatchTask } = await import("../dispatch.ts");
    await dispatchTask(db, cfg, backend, db.getTask("task-1")!, "claude", { useWorktree: false, model: "sonnet" });

    const events = db.listTaskEvents("task-1");
    const prompt = events.find((e) => e.kind === "prompt");
    assert.ok(prompt, "the prompt is in the history");
    assert.match(prompt.message, /Initial prompt sent to claude/);
    const data = dataOf(prompt);
    assert.equal(data.source, "dispatch");
    assert.equal(data.harness, "claude");
    assert.equal(data.model, "sonnet");
    assert.match(String(data.text), /Add caching/, "the text is kept so the modal can show it");
    // The dispatch's own state changes (status, branch, worktree) come first,
    // then the prompt that started the run.
    assert.equal(kinds(events)[0], "status");
    assert.equal(events.at(-1)?.kind, "prompt");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent question and a human reply land on the task's history", withDb(async (db) => {
  db.insertTask(makeTask({ status: "dispatched", terminal_address: "s1" }));
  const { backend } = fakeBackend();
  const engine = new CaptureEngine(db, backend, { broadcast: () => undefined });
  await engine.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "blocked", turn: 1 });
  const question = db.listTaskEvents("task-1").find((e) => e.kind === "question");
  assert.ok(question, "the question is in the history");
  assert.match(question.message, /needs you/);
}));

test("PR milestones are recorded: ready, then not ready again", withDb(async (db) => {
  db.insertTask(makeTask({ status: "dispatched", branch: "feat/x", terminal_address: "s1" }));
  const hub = { broadcast: () => undefined };
  const pr = (over: Partial<PrInfo>): PrInfo => ({
    url: "https://github.com/example/repo/pull/7", title: "feat: x", state: "OPEN", number: 7, description: "x",
    additions: 1, deletions: 1, changed_files: 1, mergeable: "MERGEABLE", base_ref: "main",
    review_decision: null, human_approvals: null, checks: { total: 1, failed: 0, pending: false }, threads: [],
    ...over,
  });
  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr({}) });
  let events = db.listTaskEvents("task-1");
  assert.deepEqual(messages(events).filter((m) => m.startsWith("PR ")), [
    "PR linked: https://github.com/example/repo/pull/7",
    "PR ready for review",
  ]);

  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => pr({ threads: [{ id: "t1", author: "r", body: "fix this" }], checks: { total: 1, failed: 1, pending: false } }),
  });
  events = db.listTaskEvents("task-1");
  assert.ok(messages(events).some((m) => m.startsWith("PR no longer ready")), "losing readiness is a milestone too");
}));

// ---- the endpoint ----

test("GET /api/tasks/:id/events returns one task's history, oldest first", withDb(async (db) => {
  db.insertTask(makeTask());
  logTaskEvent(db, "task-1", "created", "Task created", { source: "manual" });
  db.updateTask("task-1", { status: "dispatched" });
  db.insertTask(makeTask({ id: "task-2", title: "Other" }));
  logTaskEvent(db, "task-2", "created", "Task created");

  const server = createHttpServer({
    db,
    backend: fakeBackend().backend,
    hub: { broadcast: () => undefined },
    cfg: { token: "test", configDir: "/nonexistent", host: "127.0.0.1", port: 4787 },
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const get = (path: string, token = "test") => fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const res = await get("/api/tasks/task-1/events");
    assert.equal(res.status, 200);
    const events = await res.json() as TaskEvent[];
    assert.deepEqual(messages(events), ["Task created", "Status: open → dispatched"]);
    assert.equal(events[0].task_id, "task-1");

    assert.equal((await get("/api/tasks/task-1/events?limit=1")).status, 200);
    const capped = await (await get("/api/tasks/task-1/events?limit=1")).json() as TaskEvent[];
    assert.deepEqual(messages(capped), ["Status: open → dispatched"], "a limit keeps the newest events");

    assert.equal((await get("/api/tasks/nope/events")).status, 404);
    assert.equal((await get("/api/tasks/task-1/events", "wrong")).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));
