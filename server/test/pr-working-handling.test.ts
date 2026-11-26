import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { CaptureEngine } from "../capture.ts";
import { syncTaskPr, type PrInfo } from "../pr.ts";
import { instructTask } from "../agent-control.ts";
import { createHttpServer, type AppState } from "../api.ts";
import type { WorkerBackend, WorkerSession } from "../worker.ts";
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
    const dir = mkdtempSync(join(tmpdir(), "corral-pr-working-"));
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
    title: "Fix working PR handling",
    prompt: "Implement fix",
    kind: "code",
    repo_path: "/tmp/repo",
    target: "claude",
    target_state: "confirmed",
    base_branch: "main",
    branch: "fix/working",
    worktree_path: "/tmp/wt",
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: "https://github.com/org/repo/pull/12",
    pr_meta: null,
    status: "dispatched",
    terminal_address: "s1",
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    ...over,
  };
}

function makeGreenPr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    url: "https://github.com/org/repo/pull/12",
    title: "feat: fix",
    state: "OPEN",
    number: 12,
    description: "",
    additions: 1,
    deletions: 0,
    changed_files: 1,
    mergeable: "MERGEABLE",
    base_ref: "main",
    review_decision: null,
    human_approvals: null,
    checks: { total: 1, failed: 0, pending: false },
    threads: [],
    threads_known: true,
    ...over,
  };
}

function makeSession(over: Partial<WorkerSession> = {}): WorkerSession {
  return {
    address: "s1",
    task_id: "task-1",
    name: "corral-test",
    harness: "claude",
    status: "working",
    blocked_kind: null,
    state: "live",
    turn: 1,
    cwd: "/tmp/wt",
    created_ms: Date.now(),
    exit_code: null,
    parent: null,
    ...over,
  };
}

function makePrItem(over: Partial<Item> = {}): Item {
  const now = Date.now();
  return {
    id: "item-1",
    kind: "pr",
    status: "open",
    title: "PR ready for review: feat: fix",
    summary: "ready for review",
    body: "PR: https://github.com/org/repo/pull/12",
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

test("syncTaskPr creates a new green PR item with handling=1 while the session is working", withEnv(async ({ db, backend, hub }) => {
  db.insertTask(makeTask());
  backend.get = async () => makeSession({ status: "working" });

  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => makeGreenPr(), backend });
  const item = db.listItems({ kind: "pr" })[0];
  assert.equal(item.ready, 1);
  assert.equal(item.handling, 1, "green PR stays in In progress while session is working");

  // Also works via terminals.last_status fallback when backend.get fails.
  db.insertTask(makeTask({ id: "task-2", terminal_address: "s2", branch: "fix/fallback" }));
  db.upsertTerminal({ address: "s2", task_id: "task-2", name: null, agent: "claude", last_status: "working", last_turn: 1, updated_ms: Date.now() });
  backend.get = async () => { throw new Error("backend unreachable"); };

  await syncTaskPr(db, hub, db.getTask("task-2")!, { finder: () => makeGreenPr(), backend });
  const fallbackItem = db.findPrItemForTask("task-2")!;
  assert.equal(fallbackItem.ready, 1);
  assert.equal(fallbackItem.handling, 1, "falls back to tracked terminal status when backend is unreachable");
}));

test("syncTaskPr preserves handling=1 on an existing green PR item while working and clears it once idle", withEnv(async ({ db, backend, hub }) => {
  db.insertTask(makeTask());
  db.insertItem(makePrItem({ handling: 1 }));

  let sessionStatus = "working";
  backend.get = async () => makeSession({ status: sessionStatus });

  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => makeGreenPr(), backend });
  assert.equal(db.getItem("item-1")!.handling, 1, "handling stays 1 while session is working");

  sessionStatus = "idle";
  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => makeGreenPr(), backend });
  assert.equal(db.getItem("item-1")!.handling, 0, "handling clears once session is idle and gate passes");
}));

test("CaptureEngine moves a non-snoozed open green PR item to handling=1 when session works and clears on idle/finished", withEnv(async ({ db, backend, hub }) => {
  db.insertTask(makeTask());
  db.insertItem(makePrItem({ handling: 0, snooze_until_ms: null }));

  const capture = new CaptureEngine(db, backend, hub);

  // Initial created event with status=working sets handling=1.
  await capture.handleEvent({ type: "created", address: "s1", task_id: "task-1", status: "working" });
  assert.equal(db.getItem("item-1")!.handling, 1);

  // Transition to idle clears handling back to 0 (ready for review in Open).
  await capture.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "idle" });
  assert.equal(db.getItem("item-1")!.handling, 0);

  // Resuming work sets handling=1 again.
  await capture.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "working" });
  assert.equal(db.getItem("item-1")!.handling, 1);

  // Child/unrelated session ending must not clear handling for s1.
  await capture.handleEvent({ type: "status", address: "s-child", task_id: "task-1", status: "idle" });
  assert.equal(db.getItem("item-1")!.handling, 1);

  // Session finishing clears handling back to 0.
  await capture.handleEvent({ type: "finished", address: "s1", task_id: "task-1", exit_code: 0 });
  assert.equal(db.getItem("item-1")!.handling, 0);
}));

test("CaptureEngine.onFinished updates terminals.last_status from working so syncTaskPr does not see stale working", withEnv(async ({ db, backend, hub }) => {
  db.insertTask(makeTask());
  db.upsertTerminal({ address: "s1", task_id: "task-1", name: null, agent: "claude", last_status: "working", last_turn: 1, updated_ms: Date.now() });

  const capture = new CaptureEngine(db, backend, hub);
  await capture.handleEvent({ type: "finished", address: "s1", task_id: "task-1", exit_code: 0 });
  assert.equal(db.getTerminal("s1")?.last_status, "done");

  // Sync without backend.get (using terminals fallback) sees done, not working.
  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => makeGreenPr() });
  assert.equal(db.listItems({ kind: "pr" })[0].handling, 0);

  // Non-zero exit code records error.
  db.insertTask(makeTask({ id: "task-2", terminal_address: "s2" }));
  db.upsertTerminal({ address: "s2", task_id: "task-2", name: null, agent: "claude", last_status: "working", last_turn: 1, updated_ms: Date.now() });
  await capture.handleEvent({ type: "finished", address: "s2", task_id: "task-2", exit_code: 1 });
  assert.equal(db.getTerminal("s2")?.last_status, "error");
}));

test("instructTask and artifact request move a non-snoozed open green PR item to handling=1", withEnv(async ({ db, backend, hub, call }) => {
  db.insertTask(makeTask({ id: "t1", terminal_address: "s1" }));
  db.insertItem(makePrItem({ id: "i1", task_id: "t1", source_ref: "s1", handling: 0, snooze_until_ms: null }));

  const mode = await instructTask({ db, backend, hub }, "t1", "Please also update the README");
  assert.equal(mode, "session");
  assert.equal(db.getItem("i1")!.handling, 1);

  db.insertTask(makeTask({ id: "t2", target: "claude", terminal_address: "s2" }));
  db.insertItem(makePrItem({ id: "i2", task_id: "t2", source_ref: "s2", handling: 0, snooze_until_ms: null }));

  const res = await call("POST", "/api/tasks/t2/artifact");
  assert.equal(res.status, 200);
  assert.equal(db.getItem("i2")!.handling, 1);
}));
