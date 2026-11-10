// Review tasks: review an existing PR/MR, no branch, no PR loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { dispatchTask } from "../dispatch.ts";
import type { Config } from "../config.ts";
import { prCandidateTasks, syncTaskPr, type PrInfo } from "../pr.ts";
import { CaptureEngine } from "../capture.ts";
import { createHttpServer, type AppState } from "../api.ts";
import type { WorkerBackend, WorkerStart, WorkerSession } from "../worker.ts";
import type { Task } from "../types.ts";

const MR = "https://gitlab.com/group/project/-/merge_requests/42";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Review MR !42", prompt: "", kind: "review", repo_path: "/tmp/repo",
    target: "claude", target_state: "suggested", base_branch: null, branch: null, worktree_path: null,
    assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: MR, pr_meta: null,
    status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now, ...over,
  };
}

function fakeBackend() {
  const started: WorkerStart[] = [];
  const sent: string[] = [];
  const backend = {
    name: "fake",
    async start(s: WorkerStart): Promise<WorkerSession> {
      started.push(s);
      return {
        address: "s1", task_id: s.taskId, name: s.name, harness: s.harness, status: "working",
        blocked_kind: null, state: "live", turn: 1, cwd: s.repoPath, created_ms: Date.now(), exit_code: null, parent: null,
      };
    },
    list: async () => [],
    get: async () => null,
    read: async () => "",
    send: async (_a: string, text: string) => { sent.push(text); },
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop: () => undefined }),
  } as WorkerBackend;
  return { backend, started, sent };
}

function withDb(fn: (db: Db, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-review-task-"));
    const db = new Db(join(dir, "test.db"));
    try {
      await fn(db, dir);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("db: tasks default to kind code and keep kind review", withDb(async (db) => {
  const { kind: _kind, ...legacy } = makeTask({ id: "legacy" });
  db.insertTask(legacy);
  db.insertTask(makeTask());
  assert.equal(db.getTask("legacy")?.kind, "code");
  assert.equal(db.getTask("task-1")?.kind, "review");
}));

test("PR loop ignores review tasks: the reviewed MR's threads are not agent work", withDb(async (db) => {
  db.insertTask(makeTask({ status: "dispatched", branch: "feat-x", terminal_address: "s1" }));
  const { backend, sent } = fakeBackend();
  let finderCalls = 0;
  const finder = (): PrInfo => {
    finderCalls++;
    throw new Error("finder must not run for a review task");
  };
  const result = await syncTaskPr(db, { broadcast: () => undefined }, db.getTask("task-1")!, {
    finder, backend, cfg: { configDir: "/nonexistent", host: "localhost", port: 1, token: "" } as Config,
  });
  assert.equal(result, null);
  assert.equal(finderCalls, 0);
  assert.equal(sent.length, 0);
  assert.equal(db.listItems({ kind: "pr" }).length, 0);
  assert.deepEqual(prCandidateTasks(db), []);
}));

test("dispatch: a review runs in the repo with no worktree, no branch, and the review convention", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir]);
  const task = makeTask({ repo_path: dir });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  const cfg = { configDir: dir, host: "localhost", port: 4787, token: "tok" } as Config;
  await assert.rejects(dispatchTask(db, cfg, backend, task, "codex"), /claude harness only/);
  // Claude dispatch pre-trusts the workspace in ~/.claude.json: keep it in the temp dir.
  const home = process.env.HOME;
  process.env.HOME = dir;
  let result;
  try {
    result = await dispatchTask(db, cfg, backend, task, "claude", { useWorktree: true });
  } finally {
    process.env.HOME = home;
  }
  assert.equal(started.length, 1);
  assert.equal(started[0].git, null);
  assert.equal(result.branch, "");
  assert.equal(db.getTask(task.id)?.branch, null);
  assert.equal(db.getTask(task.id)?.status, "dispatched");
  const prompt = started[0].prompt;
  assert.match(prompt, /fabien-reviewer/);
  assert.ok(prompt.includes(`Review this PR/MR: ${MR}`));
  assert.ok(prompt.includes(`Drafts: ${MR}`), "placeholders are filled");
  assert.doesNotMatch(prompt, /gh pr create|glab mr create|\{task_id\}|\{pr_url\}/);
}));

test("capture: a finished review is reported as information, not an unready PR", withDb(async (db) => {
  db.insertTask(makeTask({ status: "dispatched", terminal_address: "s1" }));
  const { backend } = fakeBackend();
  const engine = new CaptureEngine(db, backend, { broadcast: () => undefined });
  const item = await engine.createStructuredQuestion({ kind: "done", taskId: "task-1", title: "Review published", body: `3 comments\n\nMR: ${MR}` });
  assert.equal(item.kind, "digest");
  assert.equal(item.ready, 1);
  assert.equal(db.listItems({ kind: "pr" }).length, 0);
  assert.equal(db.getTask("task-1")?.status, "done");
}));

test("api: review tasks need a PR/MR URL, keep their kind, and refuse other harnesses", withDb(async (db, dir) => {
  const { backend } = fakeBackend();
  const server = createHttpServer({ db, backend, hub: { broadcast: () => undefined }, cfg: { token: "test", configDir: dir } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await call("POST", "/api/tasks", { kind: "review", repo_path: dir })).status, 400);
    assert.equal((await call("POST", "/api/tasks", { kind: "review", pr_url: "https://example.com/not-a-pr" })).status, 400);
    assert.equal((await call("POST", "/api/tasks", { kind: "other", prompt: "x" })).status, 400);
    const created = await (await call("POST", "/api/tasks", { kind: "review", pr_url: MR, repo_path: dir })).json() as Task;
    assert.equal(created.kind, "review");
    assert.equal(created.pr_url, MR);
    assert.equal(created.title, `Review ${MR}`);
    const patched = await (await call("PATCH", `/api/tasks/${created.id}`, { kind: "code" })).json() as Task;
    assert.equal(patched.kind, "review");
    const dispatch = await call("POST", `/api/tasks/${created.id}/dispatch`, { target: "codex" });
    assert.equal(dispatch.status, 400);
    assert.match((await dispatch.json() as { error: string }).error, /claude/);
    assert.equal((await call("POST", `/api/tasks/${created.id}/check-pr`)).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));
