// A live PR item must follow its PR even when the task left the normal queue.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { findPr, prCandidateTasks, syncAllPrs, syncTaskPr, type PrInfo } from "../pr.ts";
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

async function withFakeGh(fn: (dir: string) => Promise<void>): Promise<void> {
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
    await fn(dir);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("findPr looks up a reported URL without a local repo", async () => {
  await withFakeGh(async () => {
    const found = await findPr("", URL);
    assert.equal(found?.state, "MERGED");
    assert.equal(found?.url, URL);
  });
});

test("findPr follows a reported URL when the task's checkout is gone", async () => {
  await withFakeGh(async (dir) => {
    const found = await findPr(join(dir, "deleted-checkout"), URL);
    assert.equal(found?.state, "MERGED", "a missing local path must not hide a merged PR");
    assert.equal(found?.url, URL);
  });
});

test("periodic sync checks live PR items before other candidates", withDb(async (db) => {
  const now = Date.now();
  db.insertTask(task({ id: "task-old", created_ms: now - 60_000, branch: "old-branch", pr_url: URL }));
  db.insertTask(task({ id: "task-new", created_ms: now, branch: "new-branch", pr_url: "https://example.com/repos/1/pulls/8" }));
  db.insertItem(prItem({ task_id: "task-old" }));
  const checked: string[] = [];

  await syncAllPrs(db, hub, { finder: (_repo, ref) => { checked.push(ref); return pr(); } }, 0);

  assert.equal(checked[0], URL, "the task with a live inbox item is refreshed first, whatever its age");
  assert.deepEqual(new Set(checked), new Set([URL, "https://example.com/repos/1/pulls/8"]));
}));

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

test("periodic sync skips already-merged done tasks with no live PR item", withDb(async (db) => {
  const mergedMeta = JSON.stringify({ pr: { url: URL, state: "MERGED" } });
  db.insertTask(task({ id: "merged-archived", status: "done", pr_meta: mergedMeta, pr_url: "https://gitlab.example/g/p/-/merge_requests/1" }));
  db.insertItem(prItem({ id: "item-archived", task_id: "merged-archived", status: "archived" }));
  db.insertTask(task({ id: "merged-still-open", status: "done", pr_meta: mergedMeta, pr_url: "https://gitlab.example/g/p/-/merge_requests/2" }));
  db.insertItem(prItem({ id: "item-open", task_id: "merged-still-open", status: "open" }));
  db.insertTask(task({ id: "active", status: "done", pr_meta: JSON.stringify({ pr: { url: URL, state: "OPEN" } }), pr_url: "https://gitlab.example/g/p/-/merge_requests/3" }));

  assert.deepEqual(prCandidateTasks(db).map((t) => t.id), ["active"]);

  const checked: string[] = [];
  await syncAllPrs(db, hub, { finder: (_repo, ref) => { checked.push(ref); return pr({ url: ref }); } }, 0);

  assert.deepEqual(
    checked,
    ["https://gitlab.example/g/p/-/merge_requests/2", "https://gitlab.example/g/p/-/merge_requests/3"],
    "historical merged tasks without live items are skipped while live items still resolve",
  );
  assert.equal(db.getItem("item-open")?.status, "archived");
}));

test("findPr routes GitLab MR URLs straight to glab and skips detail calls when merged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-glab-merged-"));
  const originalPath = process.env.PATH;
  const logFile = join(dir, "calls.log");
  try {
    writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "gh $*" >> "${logFile}"\nexit 1\n`, { mode: 0o755 });
    writeFileSync(join(dir, "glab"), `#!/bin/sh
echo "glab $*" >> "${logFile}"
case "$*" in
  "mr view 42 --repo https://gitlab.example/group/sub/proj --output json")
    echo '{"iid":42,"project_id":99,"state":"merged","title":"Ship it","web_url":"https://gitlab.example/group/sub/proj/-/merge_requests/42"}'
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    process.env.PATH = `${dir}:${originalPath}`;

    const found = await findPr(dir, "https://gitlab.example/group/sub/proj/-/merge_requests/42");
    assert.equal(found?.state, "MERGED");
    assert.equal(found?.url, "https://gitlab.example/group/sub/proj/-/merge_requests/42");
    // Legacy URL without /-/ also resolves.
    const legacy = await findPr(dir, "https://gitlab.example/group/sub/proj/merge_requests/42");
    assert.equal(legacy?.state, "MERGED");

    const calls = readFileSync(logFile, "utf8").trim().split("\n");
    assert.equal(calls.some((line) => line.startsWith("gh ")), false, "gh is never invoked for GitLab MR URLs");
    assert.equal(calls.some((line) => line.startsWith("glab api ")), false, "extra glab api calls are skipped for merged MRs");
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPr reads open GitLab MR details from the MR's own project and host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-glab-cross-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(dir, "glab"), `#!/bin/sh
case "$*" in
  "mr view 23 --repo https://gitlab.example/g/other --output json")
    echo '{"iid":23,"project_id":42,"state":"opened","title":"Cross","web_url":"https://gitlab.example/g/other/-/merge_requests/23"}'
    ;;
  "api --hostname gitlab.example projects/42/merge_requests/23/approvals")
    echo '{"approved_by":[{"user":{"username":"alice","bot":false}}]}'
    ;;
  "api --hostname gitlab.example projects/42/merge_requests/23/changes")
    echo '{"changes":[]}'
    ;;
  "api --hostname gitlab.example projects/42/merge_requests/23/discussions?per_page=100")
    echo '[]'
    ;;
  "api --hostname gitlab.example projects/42/merge_requests/23")
    echo '{"has_conflicts":false,"head_pipeline":{"status":"success"}}'
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    process.env.PATH = `${dir}:${originalPath}`;

    const found = await findPr(dir, "https://gitlab.example/g/other/-/merge_requests/23");
    assert.ok(found);
    assert.equal(found.state, "OPEN");
    assert.deepEqual(found.human_approvals, ["alice"]);
    assert.equal(found.mergeable, "MERGEABLE");
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncTaskPr updates the live PR item even when a newer archived PR item exists", withDb(async (db) => {
  const now = Date.now();
  db.insertTask(task({ id: "task-1", status: "done" }));
  db.insertItem(prItem({ id: "item-live", status: "open", created_ms: now - 1000 }));
  db.insertItem(prItem({ id: "item-archived", status: "archived", created_ms: now }));

  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr({ state: "CLOSED" }) });

  assert.equal(db.getItem("item-live")?.status, "resolved");
  assert.equal(db.getItem("item-archived")?.status, "archived");
}));
