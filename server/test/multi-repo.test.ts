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

function fakeBackend(opts: { sendError?: Error } = {}) {
  const started: WorkerStart[] = [];
  const sent: { address: string; message: string }[] = [];
  let sendError: Error | null = opts.sendError ?? null;
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
    send: async (address: string, message: string) => {
      if (sendError) throw sendError;
      sent.push({ address, message });
    },
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop: () => undefined }),
  } as WorkerBackend;
  return { backend, started, sent, setSendError: (err: Error | null) => { sendError = err; } };
}

/** A folder holding two git repos and one plain directory. */
function withFolder(fn: (ctx: {
  db: Db;
  dir: string;
  folder: string;
  started: WorkerStart[];
  sent: { address: string; message: string }[];
  setSendError: (err: Error | null) => void;
  call: (m: string, p: string, b?: unknown) => Promise<Response>;
}) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-multi-"));
    const folder = join(dir, "work");
    for (const name of ["spec", "core"]) {
      mkdirSync(join(folder, name), { recursive: true });
      execFileSync("git", ["init", "-q", join(folder, name)]);
    }
    mkdirSync(join(folder, "docs"));
    const db = new Db(join(dir, "test.db"));
    const { backend, started, sent, setSendError } = fakeBackend();
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
      await fn({ db, dir, folder, started, sent, setSendError, call });
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
  const storedSpec = JSON.parse(db.getTask(task.id)!.spec!) as { revision_id: string; version: number };
  assert.ok(storedSpec.revision_id);
  assert.equal(storedSpec.version, 1);
  assert.equal((await call("POST", `/api/tasks/${task.id}/approve-plan`)).status, 400, "revision_id required");
  const res = await call("POST", `/api/tasks/${task.id}/approve-plan`, { revision_id: storedSpec.revision_id });
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
  assert.equal((await call("POST", `/api/tasks/${task.id}/approve-plan`, { revision_id: storedSpec.revision_id })).status, 400, "approval is once");

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

test("approve: refuses a non-spec task and a plan whose folder changed", withFolder(async ({ db, folder, call }) => {
  const code = (await (await call("POST", "/api/tasks", { prompt: "p", repo_path: folder })).json()) as Task;
  assert.equal((await call("POST", `/api/tasks/${code.id}/approve-plan`)).status, 400);
  assert.equal((await call("POST", `/api/tasks/nope/approve-plan`)).status, 404);
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "p", repo_path: folder })).json()) as Task;
  await call("POST", "/api/reports", plan(task.id, [{ repo: "core", title: "t", prompt: "p" }]));
  const revId = (JSON.parse(db.getTask(task.id)!.spec!) as { revision_id: string }).revision_id;
  rmSync(join(folder, "core"), { recursive: true, force: true });
  assert.equal((await call("POST", `/api/tasks/${task.id}/approve-plan`, { revision_id: revId })).status, 400);
}));

test("plan revisions: multi-revision lifecycle, request changes, handling state, and v2 return to open", withFolder(async ({ db, folder, sent, call }) => {
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "Add field X", repo_path: folder })).json()) as Task;
  await call("POST", `/api/tasks/${task.id}/dispatch`, { target: "claude" });
  const r1 = await call("POST", "/api/reports", plan(task.id, [
    { repo: "spec", title: "Add x to the spec", prompt: "Edit openapi.yaml" },
    { repo: "core", title: "Serve x", prompt: "Implement POST /v1/x" },
  ]));
  assert.equal(r1.status, 200);
  const item1 = (await r1.json()) as Item;
  assert.equal(item1.handling, 0);

  const hist1 = (await (await call("GET", `/api/tasks/${task.id}/plan-revisions`)).json()) as {
    current_revision_id: string;
    approved_revision_id: string | null;
    revisions: { id: string; version: number }[];
    reviews: unknown[];
  };
  assert.equal(hist1.revisions.length, 1);
  assert.equal(hist1.revisions[0].version, 1);
  assert.equal(hist1.current_revision_id, hist1.revisions[0].id);
  assert.equal(hist1.approved_revision_id, null);

  // Empty feedback is rejected (400).
  const emptyReq = await call("POST", `/api/tasks/${task.id}/request-plan-changes`, {
    revision_id: hist1.current_revision_id,
    note: "   ",
    comments: [],
  });
  assert.equal(emptyReq.status, 400);

  // Request changes sends formatted prompt, persists plan_reviews, and flips handling = 1.
  const changeRes = await call("POST", `/api/tasks/${task.id}/request-plan-changes`, {
    revision_id: hist1.current_revision_id,
    note: "Clarify retry behavior.",
    comments: [
      {
        section: "Contract",
        repo: null,
        quote: "POST /v1/x returns {x: string}.",
        body: "Specify idempotency key header and 409 semantics.",
      },
    ],
  });
  assert.equal(changeRes.status, 200);
  const changeJson = (await changeRes.json()) as { review: { id: string; revision_id: string }; item: Item; sent_to: string };
  assert.equal(changeJson.sent_to, "s1");
  assert.equal(changeJson.item.handling, 1);
  assert.equal(db.getItem(item1.id)?.handling, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /The human requested changes to plan v1\./);
  assert.match(sent[0].message, /Clarify retry behavior\./);
  assert.match(sent[0].message, /1\. \*\*Section:\*\* Contract/);
  assert.match(sent[0].message, /> POST \/v1\/x returns \{x: string\}\./);
  assert.match(sent[0].message, /Specify idempotency key header/);

  // Submitting v2 updates the same item in place and returns handling to 0 (Open).
  const r2 = await call("POST", "/api/reports", {
    task_id: task.id,
    kind: "plan",
    title: "Add field X (v2)",
    contract: "POST /v1/x requires Idempotency-Key and returns {x: string}.\n\nOrder: spec, then core.",
    subtasks: [
      { repo: "spec", title: "Add x + Idempotency-Key", prompt: "Edit openapi.yaml" },
      { repo: "core", title: "Serve x with idempotency", prompt: "Implement POST /v1/x" },
    ],
  });
  assert.equal(r2.status, 200);
  const item2 = (await r2.json()) as Item;
  assert.equal(item2.id, item1.id);
  assert.equal(item2.handling, 0);

  const hist2 = (await (await call("GET", `/api/tasks/${task.id}/plan-revisions`)).json()) as {
    current_revision_id: string;
    revisions: { id: string; version: number }[];
    reviews: { id: string; revision_id: string }[];
  };
  assert.equal(hist2.revisions.length, 2);
  assert.equal(hist2.revisions[1].version, 2);
  assert.equal(hist2.current_revision_id, hist2.revisions[1].id);
  assert.equal(hist2.reviews.length, 1);
  assert.equal(hist2.reviews[0].revision_id, hist1.revisions[0].id);
}));

test("plan revisions: stale revision returns 409 on request-changes and approve, v2 approval succeeds and blocks v3", withFolder(async ({ db, folder, sent, call }) => {
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "p", repo_path: folder })).json()) as Task;
  await call("POST", `/api/tasks/${task.id}/dispatch`, { target: "claude" });
  await call("POST", "/api/reports", plan(task.id, [{ repo: "spec", title: "v1", prompt: "p1" }]));
  const v1Id = (JSON.parse(db.getTask(task.id)!.spec!) as { revision_id: string }).revision_id;
  await call("POST", "/api/reports", plan(task.id, [{ repo: "spec", title: "v2", prompt: "p2" }]));
  const v2Id = (JSON.parse(db.getTask(task.id)!.spec!) as { revision_id: string }).revision_id;

  // Stale request-plan-changes from Tab A (v1) -> 409, nothing sent, no review persisted.
  const staleChanges = await call("POST", `/api/tasks/${task.id}/request-plan-changes`, {
    revision_id: v1Id,
    note: "Stale feedback",
  });
  assert.equal(staleChanges.status, 409);
  const staleChangesBody = (await staleChanges.json()) as { current_revision_id: string; current_version: number };
  assert.equal(staleChangesBody.current_revision_id, v2Id);
  assert.equal(staleChangesBody.current_version, 2);
  assert.equal(sent.length, 0);
  assert.equal(db.listPlanReviews(task.id).length, 0);

  // Stale approve-plan from Tab A (v1) -> 409, zero child tasks created.
  const staleApprove = await call("POST", `/api/tasks/${task.id}/approve-plan`, { revision_id: v1Id });
  assert.equal(staleApprove.status, 409);
  const staleApproveBody = (await staleApprove.json()) as { current_revision_id: string; current_version: number };
  assert.equal(staleApproveBody.current_revision_id, v2Id);
  assert.equal(staleApproveBody.current_version, 2);
  assert.equal(db.listTasks().filter((t) => t.parent_task_id === task.id).length, 0);

  // Tab B approves v2 -> 200 and creates child task.
  const okApprove = await call("POST", `/api/tasks/${task.id}/approve-plan`, { revision_id: v2Id });
  assert.equal(okApprove.status, 200);
  assert.equal(db.listTasks().filter((t) => t.parent_task_id === task.id).length, 1);

  // Further plan reports after approval are rejected with 409.
  const afterApprove = await call("POST", "/api/reports", plan(task.id, [{ repo: "spec", title: "v3", prompt: "p3" }]));
  assert.equal(afterApprove.status, 409);
}));

test("plan revisions: session unreachable leaves handling=0 and writes no plan_reviews row", withFolder(async ({ db, folder, setSendError, call }) => {
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "p", repo_path: folder })).json()) as Task;
  await call("POST", `/api/tasks/${task.id}/dispatch`, { target: "claude" });
  const r1 = await call("POST", "/api/reports", plan(task.id, [{ repo: "spec", title: "v1", prompt: "p1" }]));
  const item = (await r1.json()) as Item;
  const v1Id = (JSON.parse(db.getTask(task.id)!.spec!) as { revision_id: string }).revision_id;

  setSendError(new Error("session exited"));
  const res = await call("POST", `/api/tasks/${task.id}/request-plan-changes`, {
    revision_id: v1Id,
    note: "Please revise",
  });
  assert.equal(res.status, 502);
  assert.equal(db.getItem(item.id)?.handling, 0);
  assert.equal(db.listPlanReviews(task.id).length, 0);
}));

test("plan revisions: backwards compatibility for legacy spec tasks without plan_revisions rows", withFolder(async ({ db, folder, started, call }) => {
  const task = (await (await call("POST", "/api/tasks", { kind: "spec", prompt: "p", repo_path: folder, target: "claude" })).json()) as Task;
  const legacySpec = {
    contract: "Legacy contract text",
    subtasks: [{ repo: "core", title: "Legacy child", prompt: "Do legacy work" }],
  };
  db.updateTask(task.id, { spec: JSON.stringify(legacySpec) });

  const histRes = await call("GET", `/api/tasks/${task.id}/plan-revisions`);
  assert.equal(histRes.status, 200);
  const hist = (await histRes.json()) as {
    current_revision_id: string;
    revisions: { id: string; version: number; contract: string }[];
  };
  assert.equal(hist.revisions.length, 1);
  assert.equal(hist.revisions[0].version, 1);
  assert.equal(hist.revisions[0].contract, "Legacy contract text");

  // Legacy spec without revision_id can still be approved without sending revision_id.
  const approveRes = await call("POST", `/api/tasks/${task.id}/approve-plan`);
  assert.equal(approveRes.status, 200);
  const { children } = (await approveRes.json()) as { children: Task[] };
  assert.equal(children.length, 1);

  const disp = await call("POST", `/api/tasks/${children[0].id}/dispatch`, { target: "claude" });
  assert.equal(disp.status, 200);
  assert.match(started[0].prompt, /Legacy contract text/);
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
