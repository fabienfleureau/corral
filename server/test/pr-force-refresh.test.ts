// Force refresh: a human asking the inbox to check a task's PR/MR now must get
// the PR loop re-run even when the automatic hand-off already pushed the same
// review comments — the escape hatch when a hand-off did not land. The API
// reports what it handed to the agent so the inbox can say so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { syncAllPrs, syncTaskPr, type PrDelivery, type PrInfo } from "../pr.ts";
import { createHttpServer, type AppState } from "../api.ts";
import type { WorkerBackend, WorkerStart, WorkerSession } from "../worker.ts";
import type { Task } from "../types.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Add caching", prompt: "Add caching", kind: "code", repo_path: "/tmp/repo",
    target: "claude", target_state: "suggested", base_branch: null, branch: "feat-x", worktree_path: null,
    assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null,
    status: "dispatched", terminal_address: "s1", exit_code: null, created_ms: now, updated_ms: now, ...over,
  };
}

function fakeBackend() {
  const started: WorkerStart[] = [];
  const sent: { address: string; text: string }[] = [];
  const backend = {
    name: "fake",
    async start(s: WorkerStart): Promise<WorkerSession> {
      started.push(s);
      return {
        address: "s2", task_id: s.taskId, name: s.name, harness: s.harness, status: "working",
        blocked_kind: null, state: "live", turn: 1, cwd: s.repoPath, created_ms: Date.now(), exit_code: null, parent: null,
      };
    },
    list: async () => [],
    get: async (address: string) => ({
      address, task_id: "task-1", name: "x", harness: "claude", status: "idle", blocked_kind: null,
      state: "live", turn: 1, cwd: "/tmp/repo", created_ms: Date.now(), exit_code: null, parent: null,
    }),
    read: async () => "",
    send: async (address: string, text: string) => { sent.push({ address, text }); },
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop: () => undefined }),
  } as WorkerBackend;
  return { backend, started, sent };
}

const cfg = (dir: string) => ({ agents: { claude: {} }, configDir: dir, host: "127.0.0.1", port: 4787, token: "t" }) as never;

const prWithComment: PrInfo = {
  url: "https://example.com/pr/7", title: "feat: x", state: "OPEN", number: 7, description: "x",
  additions: 1, deletions: 1, changed_files: 1, mergeable: "MERGEABLE", base_ref: "main",
  review_decision: null, checks: { total: 0, failed: 0, pending: false },
  threads: [{ id: "t1", author: "reviewer", body: "please rename this" }],
};

function withDb(fn: (db: Db, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-force-refresh-"));
    const db = new Db(join(dir, "test.db"));
    try {
      await fn(db, dir);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("pr sync: a forced refresh re-hands comments the loop already pushed", withDb(async (db, dir) => {
  db.insertTask(makeTask());
  const hub = { broadcast: () => undefined };
  const { backend, sent, started } = fakeBackend();
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const finder = () => prWithComment;

  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder, backend, cfg: cfg(dir) });
  await settle();
  assert.equal(sent.length, 1, "the loop pushes the comment set once");
  assert.match(sent[0].text, /^PR review comments/);
  assert.ok(sent[0].text.includes("t1"), "the thread id reaches the agent");

  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder, backend, cfg: cfg(dir) });
  await settle();
  assert.equal(sent.length, 1, "an unchanged comment set is not pushed twice");

  const deliveries: PrDelivery[] = [];
  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder, backend, cfg: cfg(dir), force: true, onDelivered: (d) => deliveries.push(d),
  });
  assert.equal(sent.length, 2, "force re-hands the work even when already pushed");
  assert.match(sent[1].text, /^PR review comments/);
  assert.deepEqual(deliveries, [{ address: "s1", comments: true, conflict: false }]);
  assert.equal(started.length, 0, "the live session gets the message, no respawn");
  assert.equal(JSON.parse(db.getTask("task-1")!.pr_meta ?? "{}").pushed, "t1", "the signature is kept");
}));

test("periodic PR sync delivers new comments while the item is snoozed", { timeout: 5000 }, withDb(async (db, dir) => {
  db.insertTask(makeTask());
  const hub = { broadcast: () => undefined };
  const { backend, sent } = fakeBackend();
  const opts = { finder: () => ({ ...prWithComment, threads: [] }), backend, cfg: cfg(dir) };
  await syncAllPrs(db, hub, opts, 0);
  const item = db.listItems({ kind: "pr" })[0];
  const until = Date.now() + 60_000;
  db.updateItem(item.id, { snooze_until_ms: until });

  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  await syncAllPrs(db, hub, { ...opts, finder: () => prWithComment, onDelivered: delivered }, 0);
  await delivery;
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^PR review comments/);
  assert.match(sent[0].text, /please rename this/);
  assert.equal(db.getItem(item.id)!.handling, 1);
  assert.equal(db.getItem(item.id)!.snooze_until_ms, until);
}));

test("pr sync: a forced refresh with nothing to hand off leaves the agent alone", withDb(async (db, dir) => {
  db.insertTask(makeTask());
  const hub = { broadcast: () => undefined };
  const { backend, sent } = fakeBackend();
  const deliveries: PrDelivery[] = [];
  const pr: PrInfo = { ...prWithComment, threads: [] };

  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => pr, backend, cfg: cfg(dir), force: true, onDelivered: (d) => deliveries.push(d),
  });
  assert.equal(sent.length, 0, "a green PR asks nothing of the agent");
  assert.deepEqual(deliveries, []);
  assert.equal(db.listItems({ kind: "pr" })[0].ready, 1);
}));

test("pr sync: a forced refresh reports a hand-off that could not reach an agent", withDb(async (db, dir) => {
  db.insertTask(makeTask());
  const hub = { broadcast: () => undefined };
  const { backend } = fakeBackend();
  backend.get = async () => null; // session gone: the loop has to respawn
  backend.start = async () => { throw new Error("backend down"); };
  const deliveries: PrDelivery[] = [];

  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => prWithComment, backend, cfg: cfg(dir), force: true, onDelivered: (d) => deliveries.push(d),
  });
  assert.deepEqual(deliveries, [{ address: null, comments: true, conflict: false }]);
  assert.equal(JSON.parse(db.getTask("task-1")!.pr_meta ?? "{}").pushed, undefined, "nothing is marked pushed");
  assert.equal(db.listItems({ kind: "pr" })[0].handling, 0, "the item stays with the human");
}));

test("api: check-pr force re-delivers and reports the hand-off", withDb(async (db, dir) => {
  const originalPath = process.env.PATH;
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\necho https://github.com/example/repo.git\n", { mode: 0o755 });
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "pr view"*) echo '{"url":"https://github.com/example/repo/pull/7","title":"feat: x","state":"OPEN","number":7,"body":"x","additions":1,"deletions":1,"changedFiles":1,"mergeable":"MERGEABLE","baseRefName":"main","reviewDecision":null,"statusCheckRollup":[]}' ;;
  *"/reviews"*) echo '[[]]' ;;
  *graphql*) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"t1","isResolved":false,"comments":{"nodes":[{"author":{"login":"reviewer"},"body":"please rename this"}]}}]}}}}}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${originalPath}`;
  const { backend, sent } = fakeBackend();
  const server = createHttpServer({ db, backend, hub: { broadcast: () => undefined }, cfg: { token: "test", configDir: dir, host: "127.0.0.1", port: 4787 } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const call = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    db.insertTask(makeTask({ repo_path: dir }));

    const first = await (await call("/api/tasks/task-1/check-pr")).json() as { delivered: PrDelivery | null };
    assert.equal(first.delivered, null, "an automatic check reports no forced hand-off");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);

    const forced = await (await call("/api/tasks/task-1/check-pr", { force: true })).json() as {
      delivered: PrDelivery | null; task: Task;
    };
    assert.deepEqual(forced.delivered, { address: "s1", comments: true, conflict: false });
    assert.equal(sent.length, 2, "the forced check re-hand the comment set");
    assert.equal(forced.task.pr_url, "https://github.com/example/repo/pull/7");
    assert.match(db.listItems({ kind: "pr" })[0].summary, /1 unresolved review comment/);
  } finally {
    process.env.PATH = originalPath;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));
