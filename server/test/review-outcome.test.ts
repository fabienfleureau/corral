import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { CaptureEngine } from "../capture.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { collectImprovementEvidence } from "../improvement-evidence.ts";
import { isPublishQuestion } from "../review-outcome.ts";
import type { WorkerBackend } from "../worker.ts";
import type { Config } from "../config.ts";
import type { Item, Task } from "../types.ts";

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;

function withEnv(fn: (ctx: { db: Db; call: Call }) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-review-outcome-"));
    const db = new Db(join(dir, "corral.db"));
    const backend: WorkerBackend = {
      name: "fake",
      start: async () => { throw new Error("unused"); },
      list: async () => [],
      get: async () => null,
      read: async () => "",
      send: async () => undefined,
      resolveElicitation: async () => undefined,
      kill: async () => undefined,
      history: async () => "",
      tree: async () => [],
      onEvent: () => ({ stop: () => undefined }),
    };
    const hub = { broadcast: () => undefined };
    const cfg = { token: "test" } as Config;
    const capture = new CaptureEngine(db, backend, hub, cfg);
    const server = createHttpServer({ db, backend, hub, capture, cfg } as unknown as AppState);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const call: Call = async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { Authorization: "Bearer test", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    try {
      await fn({ db, call });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function reviewTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "rev-1", title: "Review MR !12", prompt: "Review", kind: "review", repo_path: "/tmp/repo", target: "claude",
    target_state: "confirmed", base_branch: "main", branch: null, worktree_path: null, assignee: null, jira_key: null,
    jira_url: null, jira_parent_key: null, pr_url: "https://gitlab.com/org/repo/-/merge_requests/12", pr_meta: null,
    status: "dispatched", terminal_address: "s1", exit_code: null, created_ms: now, updated_ms: now, ...over,
  } as Task;
}

function publishQuestion(over: Partial<Item> = {}): Item {
  const now = Date.now();
  return {
    id: "q-1", kind: "question", status: "open", title: "Publish 3 review comments on fix(auth): refresh tokens?",
    summary: "", body: "1. server/auth.ts:12 …", context: "", options: JSON.stringify(["publish all", "none"]),
    ready: 1, handling: 0, source_ref: "s1", task_id: "rev-1", structured: 1,
    created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null, ...over,
  };
}

test("the publish question is told apart from other review questions", () => {
  assert.equal(isPublishQuestion(publishQuestion()), true);
  assert.equal(isPublishQuestion(publishQuestion({ title: "Publish 1 review comment on X?", options: null })), true);
  assert.equal(isPublishQuestion(publishQuestion({ title: "Cannot fetch the MR, which remote?", options: JSON.stringify(["origin", "none"]) })), false);
});

test("archiving the publish question without a reply records the review as skipped", withEnv(async ({ db, call }) => {
  db.insertTask(reviewTask());
  db.insertItem(publishQuestion());
  assert.equal((await call("POST", "/api/items/q-1/archive")).status, 200);
  assert.equal(db.getTask("rev-1")?.review_outcome, "skipped");
  assert.ok(db.listTaskEvents("rev-1").some((e) => e.message.includes("not published: archived without reply")));
}));

test("acknowledging the publish question without a reply records skipped", withEnv(async ({ db, call }) => {
  db.insertTask(reviewTask());
  db.insertItem(publishQuestion());
  await call("POST", "/api/items/q-1/resolve");
  assert.equal(db.getTask("rev-1")?.review_outcome, "skipped");
}));

test("replying none records skipped and a later done report does not overwrite it", withEnv(async ({ db, call }) => {
  db.insertTask(reviewTask());
  db.insertItem(publishQuestion());
  await call("POST", "/api/items/q-1/reply", { text: "none" });
  assert.equal(db.getTask("rev-1")?.review_outcome, "skipped");
  await call("POST", "/api/reports", { task_id: "rev-1", kind: "done", title: "Review published: fix(auth)", body: "0 comments published." });
  assert.equal(db.getTask("rev-1")?.review_outcome, "skipped");
}));

test("an approved publish question followed by the done report records published", withEnv(async ({ db, call }) => {
  db.insertTask(reviewTask());
  db.insertItem(publishQuestion());
  await call("POST", "/api/items/q-1/reply", { text: "1,3" });
  assert.equal(db.getTask("rev-1")?.review_outcome ?? null, null, "unknown until the agent reports");
  // Archiving an answered question is not a skip.
  await call("POST", "/api/items/q-1/archive");
  assert.equal(db.getTask("rev-1")?.review_outcome ?? null, null);
  await call("POST", "/api/reports", { task_id: "rev-1", kind: "done", title: "Review published: fix(auth)", body: "2 comments published." });
  assert.equal(db.getTask("rev-1")?.review_outcome, "published");
}));

test("other review questions and non-review tasks record nothing", withEnv(async ({ db, call }) => {
  db.insertTask(reviewTask());
  db.insertItem(publishQuestion({ id: "q-other", title: "Cannot fetch the MR, which remote?", options: JSON.stringify(["origin", "none"]) }));
  await call("POST", "/api/items/q-other/archive");
  assert.equal(db.getTask("rev-1")?.review_outcome ?? null, null);

  db.insertTask(reviewTask({ id: "code-1", kind: "code" }));
  db.insertItem(publishQuestion({ id: "q-code", task_id: "code-1" }));
  await call("POST", "/api/items/q-code/archive");
  assert.equal(db.getTask("code-1")?.review_outcome ?? null, null);
}));

test("improvement evidence counts publish questions closed without a reply", withEnv(async ({ db, call }) => {
  db.insertTask(reviewTask());
  db.insertItem(publishQuestion());
  db.insertItem(publishQuestion({ id: "q-answered", status: "resolved" }));
  db.recordMetric("item.replied", "q-answered", { address: "s1" });
  db.insertItem(publishQuestion({ id: "q-open" }));
  await call("POST", "/api/items/q-1/archive");

  const evidence = collectImprovementEvidence(db);
  assert.deepEqual(evidence.data_quality.unpublished_reviews, { count: 1, items: [{ item_id: "q-1", task_id: "rev-1", status: "archived" }] });
  assert.equal(evidence.tasks.find((t) => t.id === "rev-1")?.review_outcome, "skipped");
}));
