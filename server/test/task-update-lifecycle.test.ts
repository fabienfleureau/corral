import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { CaptureEngine, resumeSnoozedItems } from "../capture.ts";
import { createHttpServer, type AppState } from "../api.ts";
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
    const dir = mkdtempSync(join(tmpdir(), "corral-task-update-lifecycle-"));
    const db = new Db(join(dir, "corral.db"));
    const sent: { address: string; text: string }[] = [];
    const broadcast: [string, unknown][] = [];
    const backend: WorkerBackend = {
      name: "fake",
      start: async () => { throw new Error("unused"); },
      list: async () => [],
      get: async () => null,
      read: async () => "tail",
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
    title: "Local recipe task",
    prompt: "Run local recipe",
    kind: "code",
    repo_path: "/tmp/no-remote-repo",
    target: "codex",
    target_state: "confirmed",
    base_branch: null,
    branch: "corral/local-recipe",
    worktree_path: null,
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: null,
    pr_meta: null,
    status: "dispatched",
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
    kind: "question",
    status: "open",
    title: "Old question",
    summary: "Old summary",
    body: "Old body",
    context: "",
    options: null,
    ready: 1,
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

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "condition reached");
}

test("done report on a code task with no PR settles the placeholder PR item into a ready digest", withEnv(async ({ db, backend, hub, broadcast }) => {
  db.insertTask(makeTask({ status: "dispatched", pr_url: null }));
  const capture = new CaptureEngine(db, backend, hub, null, null, {
    stoppedRetry: { maxAttempts: 0, silentStopAttempts: 0 },
    prFinder: () => null,
  });

  const first = await capture.createStructuredQuestion({
    kind: "done",
    taskId: "task-1",
    terminal: "s1",
    title: "Local recipe done",
    body: "Everything ran locally.",
  });
  assert.equal(first.kind, "pr");
  assert.equal(first.summary, "checking the PR");

  await until(() => db.getItem(first.id)?.kind === "digest");
  const settled = db.getItem(first.id)!;
  assert.equal(settled.ready, 1);
  assert.equal(settled.handling, 0);
  assert.equal(settled.summary, "Everything ran locally.");
  assert.equal(db.getTask("task-1")?.status, "done");
  assert.equal(db.getTask("task-1")?.outcome, "reported");
  assert.ok(broadcast.some(([type, data]) => type === "item.updated" && (data as Item).id === first.id && (data as Item).kind === "digest"));

  // A subsequent done report on the same no-PR task settles to a single open digest.
  const second = await capture.createStructuredQuestion({
    kind: "done",
    taskId: "task-1",
    terminal: "s1",
    title: "Console opened in Chrome",
    body: "Console is running on 127.0.0.1:4211.",
  });
  await until(() => db.getItem(second.id)?.kind === "digest");
  const openDigests = db.listOpenItemsForTask("task-1", "digest");
  assert.equal(openDigests.length, 1);
  assert.equal(openDigests[0].id, second.id);
  assert.equal(db.getItem(first.id)?.status, "resolved");
}));

test("replying to a PR item on a done task reopens the task to dispatched", withEnv(async ({ db, broadcast, call }) => {
  db.insertTask(makeTask({ status: "done", outcome: "reported", pr_url: null }));
  db.insertItem(makeItem({
    id: "pr-item",
    kind: "pr",
    status: "open",
    title: "Console opened",
    summary: "checking the PR",
    body: "Console ready",
    ready: 0,
    handling: 0,
  }));

  const res = await call("POST", "/api/items/pr-item/reply", { text: "proceed" });
  assert.equal(res.status, 200);
  assert.equal(db.getItem("pr-item")?.handling, 1);
  const task = db.getTask("task-1")!;
  assert.equal(task.status, "dispatched");
  assert.equal(task.outcome, null);
  assert.ok(broadcast.some(([type, data]) => type === "task.updated" && (data as Task).status === "dispatched"));
}));

test("resumeSnoozedItems on a snoozed PR item reopens a done task to dispatched", withEnv(async ({ db, hub, broadcast }) => {
  const now = Date.now();
  db.insertTask(makeTask({ status: "done", outcome: "reported" }));
  db.insertItem(makeItem({
    id: "snoozed-pr",
    kind: "pr",
    status: "open",
    ready: 0,
    handling: 0,
    snooze_until_ms: now + 60_000,
  }));

  const resumed = resumeSnoozedItems(db, hub, { taskId: "task-1", address: "s1" }, now);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].handling, 1);
  assert.equal(resumed[0].snooze_until_ms, null);
  assert.equal(db.getTask("task-1")?.status, "dispatched");
  assert.equal(db.getTask("task-1")?.outcome, null);
  assert.ok(broadcast.some(([type, data]) => type === "task.updated" && (data as Task).status === "dispatched"));
}));

test("reopening a resolved question via createStructuredQuestion refreshes created_ms and clears snooze", withEnv(async ({ db, backend, hub }) => {
  const now = Date.now();
  const oldTime = now - 86_400_000;
  db.insertTask(makeTask({ status: "dispatched" }));
  db.insertItem(makeItem({
    id: "old-q",
    kind: "question",
    status: "resolved",
    title: "Old question",
    body: "Old question body",
    created_ms: oldTime,
    updated_ms: oldTime,
    resolved_ms: oldTime + 1_000,
    snooze_until_ms: now + 60_000,
  }));
  // A newer open item from another task sits in the inbox.
  db.insertItem(makeItem({
    id: "newer-other",
    task_id: "other-task",
    source_ref: "s-other",
    title: "Other open item",
    created_ms: now - 10_000,
    updated_ms: now - 10_000,
  }));

  const capture = new CaptureEngine(db, backend, hub, null, null, {
    stoppedRetry: { maxAttempts: 0, silentStopAttempts: 0 },
  });
  const reopened = await capture.createStructuredQuestion({
    kind: "question",
    taskId: "task-1",
    terminal: "s1",
    title: "Restart shared cluster?",
    body: "Should I restart qovery-eks-tests?",
    options: ["Yes", "No"],
  });

  assert.equal(reopened.id, "old-q");
  assert.equal(reopened.status, "open");
  assert.equal(reopened.snooze_until_ms, null);
  assert.ok(reopened.created_ms >= now, "created_ms is bumped on reopen");
  assert.match(reopened.body, /Old question body/);
  assert.match(reopened.body, /Should I restart qovery-eks-tests\?/);

  const openItems = db.listItems({ status: "open" });
  assert.equal(openItems[0].id, "old-q", "reopened question surfaces at the top of the inbox");
}));

test("reopening a resolved question via ensureQuestionItem refreshes created_ms and clears snooze", withEnv(async ({ db, backend, hub }) => {
  const now = Date.now();
  const oldTime = now - 86_400_000;
  db.insertTask(makeTask({ status: "dispatched" }));
  db.upsertTerminal({ address: "s1", task_id: "task-1", name: null, agent: "codex", last_status: "working", last_turn: 1, updated_ms: now });
  db.insertItem(makeItem({
    id: "old-q",
    kind: "question",
    status: "resolved",
    title: "Old question",
    body: "Old question body",
    created_ms: oldTime,
    updated_ms: oldTime,
    resolved_ms: oldTime + 1_000,
    snooze_until_ms: now + 60_000,
  }));

  const capture = new CaptureEngine(db, backend, hub, null, null, {
    stoppedRetry: { maxAttempts: 0, silentStopAttempts: 0 },
  });
  await capture.handleEvent({
    type: "status",
    address: "s1",
    task_id: "task-1",
    status: "blocked",
    elicitations: [{ id: "el-1", kind: "permission", prompt: "Allow command?", choices: ["approve", "reject"] }],
  });

  const reopened = db.getItem("old-q")!;
  assert.equal(reopened.status, "open");
  assert.equal(reopened.snooze_until_ms, null);
  assert.ok(reopened.created_ms >= now, "created_ms is bumped on reopen");
}));
