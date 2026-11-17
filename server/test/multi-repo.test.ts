// Multi-repo: a spec task in a folder of sub-projects, a plan report, approval
// that creates one code task per sub-project, and the contract at child dispatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { dispatchTask } from "../dispatch.ts";
import type { Config } from "../config.ts";
import { CaptureEngine } from "../capture.ts";
import { createHttpServer, type AppState } from "../api.ts";
import type { WorkerBackend, WorkerStart, WorkerSession } from "../worker.ts";
import type { Item, Task } from "../types.ts";

function fakeBackend() {
  const started: WorkerStart[] = [];
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
    send: async () => undefined,
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop: () => undefined }),
  } as WorkerBackend;
  return { backend, started };
}

/** A folder holding two git repos and one plain directory. */
function withFolder(fn: (ctx: { db: Db; dir: string; folder: string; started: WorkerStart[]; call: (m: string, p: string, b?: unknown) => Promise<Response> }) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-multi-"));
    const folder = join(dir, "work");
    for (const name of ["spec", "core"]) {
      mkdirSync(join(folder, name), { recursive: true });
      execFileSync("git", ["init", "-q", join(folder, name)]);
    }
    mkdirSync(join(folder, "docs"));
    const db = new Db(join(dir, "test.db"));
    const { backend, started } = fakeBackend();
    const hub = { broadcast: () => undefined };
    const capture = new CaptureEngine(db, backend, hub);
    const server = createHttpServer({ db, backend, hub, capture, cfg: { token: "test", configDir: dir, host: "localhost", port: 4787 } } as unknown as AppState);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    const home = process.env.HOME;
    process.env.HOME = dir; // dispatch pre-trusts the workspace in ~/.claude.json
    try {
      await fn({ db, dir, folder, started, call });
    } finally {
      process.env.HOME = home;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const plan = (taskId: string, subtasks: unknown) => ({
  task_id: taskId, kind: "plan", title: "Add field X", contract: "POST /v1/x returns {x: string}.\n\nOrder: spec, then core.", subtasks,
});

test("api: a spec task takes a prompt and an existing non-git folder", withFolder(async ({ folder, call }) => {
  assert.equal((await call("POST", "/api/tasks", { kind: "spec", repo_path: folder })).status, 400);
  assert.equal((await call("POST", "/api/tasks", { kind: "spec", prompt: "x", repo_path: join(folder, "nope") })).status, 400);
  const created = await call("POST", "/api/tasks", { kind: "spec", prompt: "Add field X", repo_path: folder });
  assert.equal(created.status, 200);
  assert.equal(((await created.json()) as Task).kind, "spec");
}));

test("dispatch: a spec runs in the folder without worktree or PR loop, and has no PR check", withFolder(async ({ db, folder, started, call }) => {
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "Add field X", repo_path: folder })).json()) as Task;
  const res = await call("POST", `/api/tasks/${task.id}/dispatch`, { target: "claude", use_worktree: true });
  assert.equal(res.status, 200);
  assert.equal(started.length, 1);
  assert.equal(started[0].git, null);
  assert.equal(started[0].repoPath, folder);
  const prompt = started[0].prompt;
  assert.match(prompt, /Multi-repo spec for Corral/);
  assert.ok(prompt.includes(`"task_id":"${task.id}"`), "placeholders are filled");
  assert.doesNotMatch(prompt, /gh pr create|glab mr create|\{task_id\}/);
  assert.equal(db.getTask(task.id)?.branch, null);
  assert.equal((await call("POST", `/api/tasks/${task.id}/check-pr`)).status, 400);
}));

test("dispatch: an ops task runs in a plain folder without worktree or PR", withFolder(async ({ db, folder, started, call }) => {
  const created = await call("POST", "/api/tasks", { kind: "ops", prompt: "Prepare a test plan", repo_path: folder });
  assert.equal(created.status, 200);
  const task = await created.json() as Task;
  // use_worktree and a reviewer are ignored: neither applies to an ops task.
  const res = await call("POST", `/api/tasks/${task.id}/dispatch`, { target: "claude", use_worktree: true, review: "cubic" });
  assert.equal(res.status, 200, await res.text());
  assert.equal(started.length, 1);
  assert.equal(started[0].git, null);
  assert.equal(started[0].repoPath, folder);
  const prompt = started[0].prompt;
  assert.match(prompt, /Corral action task/);
  assert.ok(prompt.includes(task.id), "placeholders are filled");
  assert.doesNotMatch(prompt, /gh pr create|glab mr create|\{task_id\}/);
  assert.equal(db.getTask(task.id)?.branch, null);
  assert.equal((await call("POST", `/api/tasks/${task.id}/check-pr`)).status, 400);
  const reported = await call("POST", "/api/reports", { task_id: task.id, kind: "done", title: "Test plan", body: "Prepared it.\n\n## Handoff\nNothing left" });
  assert.equal(reported.status, 200);
  assert.equal((await reported.json() as Item).kind, "digest");
}));

test("plan report: stored on the spec task, one open plan item, refreshed on a new report", withFolder(async ({ db, folder, call }) => {
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "p", repo_path: folder })).json()) as Task;
  const subtasks = [
    { repo: "spec", title: "Add x to the spec", prompt: "Edit openapi.yaml" },
    { repo: "core", title: "Serve x", prompt: "Implement POST /v1/x" },
  ];
  const res = await call("POST", "/api/reports", plan(task.id, subtasks));
  assert.equal(res.status, 200);
  const item = (await res.json()) as Item;
  assert.equal(item.kind, "plan");
  assert.match(item.body, /## Contract[\s\S]*POST \/v1\/x[\s\S]*## Sub-tasks[\s\S]*Add x to the spec/);
  assert.equal(JSON.parse(db.getTask(task.id)!.spec!).subtasks.length, 2);
  await call("POST", "/api/reports", plan(task.id, subtasks.slice(0, 1)));
  const items = db.listItems({ kind: "plan" });
  assert.equal(items.length, 1);
  assert.equal(JSON.parse(db.getTask(task.id)!.spec!).subtasks.length, 1);
}));

test("plan report: a plan needs a spec task, and unsafe sub-task repos are refused", withFolder(async ({ db, dir, folder, call }) => {
  const code = (await (await call("POST", "/api/tasks", { prompt: "p", repo_path: join(folder, "core") })).json()) as Task;
  assert.equal((await call("POST", "/api/reports", plan(code.id, [{ repo: "core", title: "t", prompt: "p" }]))).status, 400);
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "p", repo_path: folder })).json()) as Task;
  mkdirSync(join(dir, "outside"));
  execFileSync("git", ["init", "-q", join(dir, "outside")]);
  symlinkSync(join(dir, "outside"), join(folder, "link"));
  mkdirSync(join(folder, "core", "nested"));
  const bad = [
    "../outside", join(dir, "outside"), "link", "docs", "missing", "core/nested", ".", "",
  ];
  for (const repo of bad) {
    const res = await call("POST", "/api/reports", plan(task.id, [{ repo, title: "t", prompt: "p" }]));
    assert.equal(res.status, 400, `repo ${JSON.stringify(repo)} must be refused`);
  }
  assert.equal((await call("POST", "/api/reports", plan(task.id, []))).status, 400);
  assert.equal((await call("POST", "/api/reports", plan(task.id, [
    { repo: "core", title: "a", prompt: "p" }, { repo: "core/", title: "b", prompt: "p" },
  ]))).status, 400);
  assert.equal(db.listItems({ kind: "plan" }).length, 0);
  assert.equal(db.getTask(task.id)?.spec ?? null, null);
}));

test("approve: creates one code task per sub-task, completes the spec, and each child gets the contract", withFolder(async ({ db, folder, started, call }) => {
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "p", repo_path: folder, target: "claude" })).json()) as Task;
  assert.equal((await call("POST", `/api/tasks/${task.id}/approve-plan`)).status, 400, "no plan yet");
  await call("POST", "/api/reports", plan(task.id, [
    { repo: "spec", title: "Add x to the spec", prompt: "Edit openapi.yaml" },
    { repo: "core", title: "Serve x", prompt: "Implement POST /v1/x" },
  ]));
  const res = await call("POST", `/api/tasks/${task.id}/approve-plan`);
  assert.equal(res.status, 200);
  const { children } = (await res.json()) as { children: Task[] };
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.kind, "code");
    assert.equal(child.parent_task_id, task.id);
    assert.equal(child.status, "open");
    assert.equal(child.target, "claude");
    assert.ok(db.getRepoByPath(child.repo_path), "sub-repo is registered");
  }
  assert.deepEqual(children.map((c) => c.repo_path.split("/").pop()), ["spec", "core"]);
  assert.equal(db.getTask(task.id)?.status, "done");
  assert.equal(db.listItems({ kind: "plan" })[0].status, "resolved");
  assert.equal((await call("POST", `/api/tasks/${task.id}/approve-plan`)).status, 400, "approval is once");

  // A child dispatch carries the parent's contract, and the normal PR flow.
  const dispatched = await call("POST", `/api/tasks/${children[1].id}/dispatch`, { target: "claude" });
  assert.equal(dispatched.status, 200);
  const prompt = started[0].prompt;
  assert.match(prompt, /Multi-repo contract/);
  assert.match(prompt, /POST \/v1\/x returns/);
  assert.match(prompt, /Implement POST \/v1\/x/);
  assert.match(prompt, /glab mr create/);
  assert.equal(started[0].repoPath, children[1].repo_path);
}));

test("approve: refuses a non-spec task and a plan whose folder changed", withFolder(async ({ folder, call }) => {
  const code = (await (await call("POST", "/api/tasks", { prompt: "p", repo_path: folder })).json()) as Task;
  assert.equal((await call("POST", `/api/tasks/${code.id}/approve-plan`)).status, 400);
  assert.equal((await call("POST", `/api/tasks/nope/approve-plan`)).status, 404);
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "p", repo_path: folder })).json()) as Task;
  await call("POST", "/api/reports", plan(task.id, [{ repo: "core", title: "t", prompt: "p" }]));
  rmSync(join(folder, "core"), { recursive: true, force: true });
  assert.equal((await call("POST", `/api/tasks/${task.id}/approve-plan`)).status, 400);
}));

test("dispatch: a spec on a missing folder fails, a code task on a non-git folder still fails", withFolder(async ({ db, folder }) => {
  const { backend } = fakeBackend();
  const cfg = { configDir: folder, host: "localhost", port: 1, token: "t" } as Config;
  const now = Date.now();
  const base: Task = {
    id: "t1", title: "x", prompt: "p", kind: "spec", repo_path: join(folder, "gone"), target: "claude", target_state: "suggested",
    base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: null, jira_url: null, jira_parent_key: null,
    pr_url: null, pr_meta: null, status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now,
  };
  db.insertTask(base);
  await assert.rejects(dispatchTask(db, cfg, backend, base, "claude"), /not a directory/);
  await assert.rejects(dispatchTask(db, cfg, backend, { ...base, kind: "code", repo_path: join(folder, "docs") }, "claude"), /not a git repository/);
}));
