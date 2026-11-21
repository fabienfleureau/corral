import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { CaptureEngine } from "../capture.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { instructTask } from "../agent-control.ts";
import type { WorkerBackend } from "../worker.ts";
import type { Item, Task } from "../types.ts";

function withEnv(
  fn: (ctx: {
    db: Db;
    sent: { address: string; text: string }[];
    broadcast: [string, unknown][];
    backend: WorkerBackend;
    hub: { broadcast: (type: string, data: unknown) => void };
    call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  }) => Promise<void>,
) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-snoozed-resume-"));
    const db = new Db(join(dir, "corral.db"));
    const sent: { address: string; text: string }[] = [];
    const broadcast: [string, unknown][] = [];
    const backend: WorkerBackend = {
      name: "fake",
      start: async () => { throw new Error("unused"); },
      list: async () => [],
      get: async () => null,
      read: async () => "",
      send: async (address, text) => { sent.push({ address, text }); },
      resolveElicitation: async () => undefined,
      kill: async () => undefined,
      history: async () => "",
      tree: async () => [],
      onEvent: () => ({ stop: () => undefined }),
    };
    const hub = { broadcast: (type: string, data: unknown) => { broadcast.push([type, data]); } };
    const server = createHttpServer({ db, backend, hub, cfg: { token: "test" } } as unknown as AppState);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: "Bearer test",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    try {
      await fn({ db, sent, broadcast, backend, hub, call });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1",
    title: "Fix snoozed flow",
    prompt: "Implement fix",
    kind: "code",
    repo_path: "/tmp/repo",
    target: "claude",
    target_state: "confirmed",
    base_branch: "main",
    branch: "fix/snoozed",
    worktree_path: "/tmp/wt",
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: "https://github.com/org/repo/pull/12",
    pr_meta: null,
    status: "done",
    terminal_address: "s1",
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    ...over,
  };
}

function makeItem(over: Partial<Item> = {}): Item {
  const now = Date.now();
  return {
    id: "item-1",
    kind: "pr",
    status: "open",
    title: "PR needs work: Fix snoozed flow",
    summary: "1 unresolved comment",
    body: "PR: https://github.com/org/repo/pull/12",
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
    snooze_until_ms: now + 3_600_000,
    ...over,
  };
}

test("replying to a snoozed PR item moves it to In progress (handling=1) and clears snooze", withEnv(async ({ db, sent, call }) => {
  db.insertTask(makeTask({ status: "done" }));
  db.insertItem(makeItem({ kind: "pr" }));

  const res = await call("POST", "/api/items/item-1/reply", { text: "Please address the comment" });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "Please address the comment");

  const updated = db.getItem("item-1")!;
  assert.equal(updated.status, "open");
  assert.equal(updated.handling, 1);
  assert.equal(updated.snooze_until_ms, null);
  assert.equal((res.body.item as Item).handling, 1);
  assert.equal((res.body.item as Item).snooze_until_ms, null);
}));

test("replying to a snoozed digest item on a done task resolves it, clears snooze, and reopens the task", withEnv(async ({ db, broadcast, call }) => {
  db.insertTask(makeTask({ status: "done", kind: "review" }));
  db.insertItem(makeItem({ kind: "digest", title: "Review draft" }));

  const res = await call("POST", "/api/items/item-1/reply", { text: "Also check error handling" });
  assert.equal(res.status, 200);

  const item = db.getItem("item-1")!;
  assert.equal(item.status, "resolved");
  assert.equal(item.snooze_until_ms, null);
  assert.equal(db.getTask("task-1")!.status, "dispatched");
  assert.ok(broadcast.some(([type]) => type === "task.updated"));
}));

test("replying to a snoozed item leaves it snoozed if the session cannot be reached", withEnv(async ({ db, backend, call }) => {
  backend.send = async () => { throw new Error("session offline"); };
  db.insertTask(makeTask({ status: "done" }));
  const until = Date.now() + 3_600_000;
  db.insertItem(makeItem({ kind: "pr", snooze_until_ms: until }));

  const res = await call("POST", "/api/items/item-1/reply", { text: "Try again" });
  assert.equal(res.status, 500);
  const item = db.getItem("item-1")!;
  assert.equal(item.handling, 0);
  assert.equal(item.snooze_until_ms, until);
  assert.equal(db.getTask("task-1")!.status, "done");
}));

test("CaptureEngine moves snoozed PR and question items to In progress when a stopped session starts working again", withEnv(async ({ db, backend, hub }) => {
  db.insertTask(makeTask({ id: "t-pr", status: "done", terminal_address: "s-pr" }));
  db.insertItem(makeItem({ id: "i-pr", kind: "pr", task_id: "t-pr", source_ref: "s-pr" }));
  db.upsertTerminal({ address: "s-pr", task_id: "t-pr", name: null, agent: null, last_status: "idle", last_turn: 1, updated_ms: Date.now() });

  db.insertTask(makeTask({ id: "t-q", status: "done", kind: "review", terminal_address: "s-q" }));
  db.insertItem(makeItem({ id: "i-q", kind: "question", task_id: "t-q", source_ref: "s-q" }));
  db.upsertTerminal({ address: "s-q", task_id: "t-q", name: null, agent: null, last_status: "done", last_turn: 1, updated_ms: Date.now() });

  const capture = new CaptureEngine(db, backend, hub);
  await capture.handleEvent({ type: "status", address: "s-pr", task_id: "t-pr", status: "working" });
  assert.equal(db.getItem("i-pr")!.handling, 1);
  assert.equal(db.getItem("i-pr")!.snooze_until_ms, null);

  await capture.handleEvent({ type: "status", address: "s-q", task_id: "t-q", status: "working" });
  assert.equal(db.getItem("i-q")!.status, "resolved");
  assert.equal(db.getItem("i-q")!.snooze_until_ms, null);
  assert.equal(db.getTask("t-q")!.status, "dispatched");

  // Once the PR run ends, handling clears and the item stays unsnoozed (back in Open).
  await capture.handleEvent({ type: "status", address: "s-pr", task_id: "t-pr", status: "idle" });
  assert.equal(db.getItem("i-pr")!.handling, 0);
  assert.equal(db.getItem("i-pr")!.snooze_until_ms, null);
  assert.equal(db.getItem("i-pr")!.status, "open");
}));

test("CaptureEngine leaves a snoozed item alone when the session was already working", withEnv(async ({ db, backend, hub }) => {
  db.insertTask(makeTask({ status: "dispatched", terminal_address: "s1" }));
  const until = Date.now() + 3_600_000;
  db.insertItem(makeItem({ kind: "question", snooze_until_ms: until }));
  db.upsertTerminal({ address: "s1", task_id: "task-1", name: null, agent: null, last_status: "working", last_turn: 1, updated_ms: Date.now() });

  const capture = new CaptureEngine(db, backend, hub);
  await capture.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "working" });
  assert.equal(db.getItem("item-1")!.status, "open");
  assert.equal(db.getItem("item-1")!.snooze_until_ms, until);
}));

test("instructTask and artifact request move a task's snoozed item to In progress", withEnv(async ({ db, backend, hub, call }) => {
  db.insertTask(makeTask({ id: "t1", status: "dispatched", terminal_address: "s1" }));
  db.insertItem(makeItem({ id: "i1", kind: "question", task_id: "t1", source_ref: "s1" }));

  const mode = await instructTask({ db, backend, hub }, "t1", "Keep going");
  assert.equal(mode, "session");
  assert.equal(db.getItem("i1")!.status, "resolved");
  assert.equal(db.getItem("i1")!.snooze_until_ms, null);

  db.insertTask(makeTask({ id: "t2", status: "dispatched", target: "claude", terminal_address: "s2" }));
  db.insertItem(makeItem({ id: "i2", kind: "pr", task_id: "t2", source_ref: "s2" }));

  const res = await call("POST", "/api/tasks/t2/artifact");
  assert.equal(res.status, 200);
  assert.equal(db.getItem("i2")!.handling, 1);
  assert.equal(db.getItem("i2")!.snooze_until_ms, null);
}));
