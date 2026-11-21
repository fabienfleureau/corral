// Regression tests for the PR #5 review fixes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { CaptureEngine } from "../capture.ts";
import { OmnigentBackend } from "../omnigent.ts";
import { elicitationVerdict } from "../api.ts";
import { gitlabPipelineChecks, prReady, type PrInfo } from "../pr.ts";
import { githubRepoFromUrl } from "../pulls.ts";
import { mapLimit } from "../exec.ts";
import type { WorkerBackend, WorkerEvent } from "../worker.ts";
import type { Task } from "../types.ts";

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
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: null,
    pr_meta: null,
    handoff: null,
    status: "dispatched",
    terminal_address: "s1",
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    ...over,
  } as Task;
}

function stubBackend(): WorkerBackend {
  return {
    name: "fake",
    start: async () => {
      throw new Error("no start");
    },
    list: async () => [],
    get: async () => null,
    read: async () => "tail",
    send: async () => undefined,
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop: () => undefined }),
  } as unknown as WorkerBackend;
}

function withDb(fn: (db: Db) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-review-"));
    const db = new Db(join(dir, "test.db"));
    try {
      await fn(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const blockedEvent = (type: WorkerEvent["type"]): WorkerEvent => ({
  type,
  address: "s1",
  task_id: "task-1",
  status: "blocked",
  elicitations: [{ id: "el-1", kind: "question", prompt: "Proceed?", choices: ["yes", "no"], field: "answer" }],
});

test("omnigent: overlapping poll ticks are serialized", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  let lists = 0;
  let release: () => void = () => undefined;
  const detail = new Promise<void>((r) => (release = r));
  (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, path) => {
    if (path.startsWith("/v1/sessions?")) {
      lists++;
      return { data: [{ id: "a", pending_elicitations_count: 1 }] };
    }
    await detail; // a blocked session's detail request hangs
    return { pending_elicitations: [] };
  };
  const tick = () => (backend as unknown as { tick: () => Promise<void> }).tick();
  const first = tick();
  await new Promise((r) => setTimeout(r, 5));
  await tick(); // must not start a second, overlapping poll
  assert.equal(lists, 1);
  release();
  await first;
});

test(
  "capture: a session already blocked at first sight gets its question",
  withDb(async (db) => {
    db.insertTask(makeTask());
    const engine = new CaptureEngine(db, stubBackend(), { broadcast: () => undefined });
    await engine.handleEvent(blockedEvent("created"));
    const item = db.openQuestionItemForTerminal("s1");
    assert.ok(item);
    assert.deepEqual(JSON.parse(item.elicitation ?? "null"), { id: "el-1", kind: "question", field: "answer" });
  }),
);

test(
  "capture: an agent-reported question survives a non-blocked status",
  withDb(async (db) => {
    db.insertTask(makeTask());
    const engine = new CaptureEngine(db, stubBackend(), { broadcast: () => undefined });
    await engine.handleEvent({ type: "created", address: "s1", task_id: "task-1", status: "working" });
    await engine.createStructuredQuestion({ kind: "question", taskId: "task-1", title: "Which DB?", body: "pg or sqlite" });
    await engine.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "done" });
    assert.equal(db.openQuestionItemForTerminal("s1")?.title, "Which DB?");

    // A later blocked transition does not close the human's pending question.
    await engine.handleEvent(blockedEvent("status"));
    await engine.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "working" });
    assert.equal(db.openQuestionItemForTerminal("s1")?.title, "Which DB?");
  }),
);

test(
  "capture: completion report reuses the task's PR item and stays unready",
  withDb(async (db) => {
    db.insertTask(makeTask());
    const broadcasts: string[] = [];
    const engine = new CaptureEngine(db, stubBackend(), { broadcast: (t) => broadcasts.push(t) });
    const first = await engine.createStructuredQuestion({ kind: "done", taskId: "task-1", title: "PR: x", body: "did x" });
    assert.equal(first.ready, 0);
    const second = await engine.createStructuredQuestion({ kind: "done", taskId: "task-1", title: "PR: x v2", body: "did more" });
    assert.equal(second.id, first.id);
    assert.equal(second.ready, 0);
    assert.equal(db.listItems({ kind: "pr" }).length, 1);
  }),
);

test("elicitation verdict: typed answers, yes/no, free text", () => {
  assert.deepEqual(elicitationVerdict({ id: "e", kind: "question", field: "answer" }, "postgres"), {
    action: "accept",
    content: { answer: "postgres" },
    forward: false,
  });
  assert.deepEqual(elicitationVerdict({ id: "e", kind: "permission" }, "Yes"), { action: "accept", forward: false });
  assert.deepEqual(elicitationVerdict({ id: "e", kind: "permission" }, "no"), { action: "decline", forward: false });
  assert.deepEqual(elicitationVerdict({ id: "e", kind: "permission" }, "use the other file"), { action: "decline", forward: true });
});

test("pr gate: unknown thread data keeps readiness pending", () => {
  const pr: PrInfo = {
    url: "u",
    title: "t",
    state: "OPEN",
    number: 1,
    description: "",
    additions: 0,
    deletions: 0,
    changed_files: 0,
    mergeable: "MERGEABLE",
    base_ref: "main",
    review_decision: null,
    checks: { total: 1, failed: 0, pending: false },
    threads: [],
    threads_known: false,
  };
  assert.equal(prReady(pr).ready, false);
  assert.equal(prReady({ ...pr, threads_known: true }).ready, true);
});

test("gitlab pipeline status maps to checks", () => {
  assert.deepEqual(gitlabPipelineChecks(null), { total: 0, failed: 0, pending: false });
  assert.deepEqual(gitlabPipelineChecks("success"), { total: 1, failed: 0, pending: false });
  assert.deepEqual(gitlabPipelineChecks("failed"), { total: 1, failed: 1, pending: false });
  assert.deepEqual(gitlabPipelineChecks("running"), { total: 1, failed: 0, pending: true });
});

test("github repo slug comes from the PR url", () => {
  assert.equal(githubRepoFromUrl("https://github.com/fabienfleureau/corral/pull/5"), "fabienfleureau/corral");
  assert.equal(githubRepoFromUrl("https://example.com/x"), "");
});

test("mapLimit bounds concurrency and keeps order", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.equal(peak, 2);
});

test("omnigent: permission phase exposes approval and scoped options", async () => {
  const { normalizeElicitations } = await import("../omnigent.ts");
  const [e] = normalizeElicitations([{ elicitation_id: "e", type: "response.elicitation_request", params: { phase: "agy_permission", message: "Run git log?", always_allow_pattern: "git log" } }]);
  assert.equal(e.kind, "permission");
  assert.equal(e.persistPattern, "git log");
});

test("capture: refreshes a previously captured permission on startup", withDb(async (db) => {
  db.insertTask(makeTask());
  const engine = new CaptureEngine(db, stubBackend(), { broadcast: () => undefined });
  await engine.handleEvent(blockedEvent("created"));
  const existing = db.openQuestionItemForTerminal("s1")!;
  await engine.handleEvent({ ...blockedEvent("created"), elicitations: [{ id: "el-1", kind: "permission", prompt: "Run git log?", choices: [], persistPattern: "git log" }] });
  const item = db.openQuestionItemForTerminal("s1")!;
  assert.equal(item.id, existing.id);
  assert.deepEqual(JSON.parse(item.elicitation!), { id: "el-1", kind: "permission", field: null, persistPattern: "git log" });
}));

test("permission button verdicts preserve the selected scope", async () => {
  const { permissionVerdict } = await import("../api.ts");
  const permission = { id: "e", kind: "permission", persistPattern: "git log" };
  assert.deepEqual(permissionVerdict(permission, "approve"), { action: "accept" });
  assert.deepEqual(permissionVerdict(permission, "reject"), { action: "decline" });
  assert.deepEqual(permissionVerdict(permission, "session"), { action: "accept", meta: { persist: "session" } });
  assert.deepEqual(permissionVerdict(permission, "always"), { action: "accept", meta: { persist: "always" } });
  assert.equal(permissionVerdict({ id: "e", kind: "permission" }, "always"), null);
  assert.equal(permissionVerdict({ id: "e", kind: "question" }, "approve"), null);
});

test("omnigent: sends scoped approval as result metadata", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  let request: unknown;
  (backend as unknown as { request: (method: string, path: string, body: unknown) => Promise<void> }).request = async (_method, _path, body) => { request = body; };
  await backend.resolveElicitation("s", "e", "accept", undefined, { persist: "session" });
  assert.deepEqual(request, { action: "accept", _meta: { persist: "session" } });
});
test("capture: sequential session questions reuse one item and retain history", withDb(async (db) => {
  db.insertTask(makeTask());
  const engine = new CaptureEngine(db, stubBackend(), { broadcast: () => undefined });
  const first = await engine.createStructuredQuestion({ taskId: "task-1", title: "First?", body: "First question" });
  db.updateItem(first.id, { status: "resolved", resolved_ms: Date.now() });
  const second = await engine.createStructuredQuestion({ taskId: "task-1", title: "Second?", body: "Second question", options: ["yes", "no"] });
  assert.equal(second.id, first.id);
  assert.equal(second.status, "open");
  assert.equal(second.resolved_ms, null);
  assert.match(second.body, /First question/);
  assert.match(second.body, /Second question/);
  assert.equal(db.listItems({ kind: "question" }).length, 1);
}));
