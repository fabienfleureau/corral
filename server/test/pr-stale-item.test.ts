// A live PR item must follow its PR even when the task left the normal queue.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { findPr, syncAllPrs, syncTaskPr, type PrInfo } from "../pr.ts";
import type { Config } from "../config.ts";
import type { Item, Task } from "../types.ts";
import type { WorkerBackend } from "../worker.ts";

const URL = "https://example.com/repos/1/pulls/7";

function task(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Add caching", prompt: "", repo_path: "/tmp/repo", target: "claude", target_state: "suggested",
    base_branch: null, branch: "feat-x", worktree_path: null, assignee: null, jira_key: null, jira_url: null,
    jira_parent_key: null, pr_url: URL, pr_meta: null, status: "done", terminal_address: null, exit_code: null,
    created_ms: now, updated_ms: now, ...over,
  };
}

function prItem(over: Partial<Item> = {}): Item {
  const now = Date.now();
  return {
    id: "item-1", kind: "pr", status: "open", title: "PR ready for review: Add caching", summary: "ready for review",
    body: `PR: ${URL}`, context: "", options: null, ready: 1, handling: 0, source_ref: null, task_id: "task-1",
    structured: 1, created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null, ...over,
  };
}

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    url: URL, title: "Add caching", state: "MERGED", number: 7, description: "", additions: 1, deletions: 0,
    changed_files: 1, mergeable: "MERGEABLE", base_ref: "main", review_decision: null, human_approvals: null,
    checks: { total: 1, failed: 0, pending: false }, threads: [], threads_known: true, ...over,
  };
}

function withDb(fn: (db: Db, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-stale-pr-"));
    const db = new Db(join(dir, "test.db"));
    try { await fn(db, dir); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

const hub = { broadcast: () => undefined };

test("periodic sync archives a ready item when the task was archived", withDb(async (db) => {
  db.insertTask(task({ status: "archived" }));
  db.insertItem(prItem());

  await syncAllPrs(db, hub, { finder: () => pr() }, 0);

  const item = db.getItem("item-1")!;
  assert.equal(item.status, "archived", "the item no longer asks for review of a merged PR");
  assert.equal(item.title, "PR merged: Add caching");
}));

test("periodic sync checks a reported PR even when the task has no branch", withDb(async (db) => {
  db.insertTask(task({ branch: null }));
  db.insertItem(prItem());

  await syncAllPrs(db, hub, { finder: () => pr() }, 0);

  assert.equal(db.getItem("item-1")?.status, "archived");
}));

test("findPr looks up a reported URL without a local repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-pr-url-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$*" in
  "pr view ${URL}"*) echo '${JSON.stringify({ url: URL, title: "Add caching", state: "MERGED", number: 7 })}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    process.env.PATH = `${dir}:${originalPath}`;

    const found = await findPr("", URL);

    assert.equal(found?.state, "MERGED");
    assert.equal(found?.url, URL);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task with no live session is never respawned by a PR sync", withDb(async (db) => {
  db.insertTask(task({ status: "archived", terminal_address: null }));
  db.insertItem(prItem({ ready: 0 }));
  const started: string[] = [];
  const backend = {
    name: "fake",
    async start(s: { taskId: string }) { started.push(s.taskId); throw new Error("must not start"); },
    async get() { return null; },
  } as unknown as WorkerBackend;
  const cfg = { configDir: "/nonexistent", host: "localhost", port: 4787, token: "" } as Config;

  await syncTaskPr(db, hub, db.getTask("task-1")!, {
    finder: () => pr({ state: "OPEN", threads: [{ id: "t1", author: "bot", body: "fix" }] }),
    backend, cfg,
  });

  assert.deepEqual(started, [], "no agent is respawned for an archived task");
}));
