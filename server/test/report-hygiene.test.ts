// Report hygiene: a PR report without a PR is a digest, a report naming the
// task's PR links it, and "ready for review" is recorded once per change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { CaptureEngine } from "../capture.ts";
import { syncTaskPr, type PrInfo } from "../pr.ts";
import { pullUrlForRemotes } from "../repo-match.ts";
import type { Task } from "../types.ts";
import type { WorkerBackend } from "../worker.ts";

const URL = "https://github.com/acme/app/pull/5";
const hub = { broadcast() {} };

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Add caching", prompt: "Add caching", repo_path: "", target: "claude",
    target_state: "suggested", base_branch: null, branch: null, worktree_path: null, assignee: null,
    jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null, status: "dispatched",
    terminal_address: null, exit_code: null, created_ms: now, updated_ms: now, ...over,
  };
}

const backend = { name: "fake", read: async () => "", send: async () => undefined } as unknown as WorkerBackend;

function gitRepo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "corral-hygiene-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
  return dir;
}

test("a pr report with no PR link becomes a digest", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask());
    const engine = new CaptureEngine(db, backend, hub);
    const item = await engine.createStructuredQuestion({ kind: "pr", taskId: "task-1", title: "Trois idées du guide", body: "(analysis, no code)" });
    assert.equal(item.kind, "digest");
    assert.equal(db.listItems({ kind: "pr" }).length, 0);
  } finally { db.close(); }
});

test("a grill report naming a PR of the task's repo links it to the task", async () => {
  const dir = gitRepo("git@github.com:acme/app.git");
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ kind: "grill", repo_path: dir }));
    const engine = new CaptureEngine(db, backend, hub);
    await engine.createStructuredQuestion({
      kind: "question", taskId: "task-1", title: "Round 2",
      body: `See https://github.com/other/lib/pull/9 for context. PR #5 ouverte : ${URL}`,
    });
    assert.equal(db.getTask("task-1")?.pr_url, URL);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a report naming only another project's PR links nothing", async () => {
  const dir = gitRepo("https://github.com/acme/app.git");
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ kind: "ops", repo_path: dir }));
    const engine = new CaptureEngine(db, backend, hub);
    await engine.createStructuredQuestion({ kind: "done", taskId: "task-1", title: "Done", body: "Upstream fix: https://github.com/other/lib/pull/9" });
    assert.equal(db.getTask("task-1")?.pr_url, null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("pull URL matching handles GitLab nested groups", () => {
  const mr = "https://gitlab.com/acme/platform/engine/-/merge_requests/3117";
  assert.equal(pullUrlForRemotes(`MR: ${mr}`, ["git@gitlab.com:acme/platform/engine.git"]), mr);
  assert.equal(pullUrlForRemotes(`MR: ${mr}`, ["git@gitlab.com:acme/engine.git"]), null);
});

function pr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    url: URL, title: "Add caching", state: "OPEN", number: 5, description: "", additions: 1, deletions: 0,
    changed_files: 1, mergeable: "MERGEABLE", base_ref: "main", review_decision: null, human_approvals: null,
    head_sha: "abc", checks: { total: 1, failed: 0, pending: false }, threads: [], threads_known: true, ...over,
  };
}

test("ready_for_review is recorded once per readiness change", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ status: "done", pr_url: URL, branch: "feat-x", repo_path: "/tmp/repo" }));
    const sync = (info: PrInfo) => syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => info });
    const events = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM metrics_events WHERE name = 'item.ready_for_review'").get() as { n: number }).n;
    const readyLogs = () => db.listTaskEvents("task-1", 100).filter((e) => e.message === "PR ready for review").length;

    await sync(pr({ checks: { total: 1, failed: 0, pending: true } }));
    await sync(pr());
    assert.equal(events(), 1);
    // A new report resets the item to "checking the PR": not a readiness change.
    const item = db.listItems({ kind: "pr" })[0];
    db.updateItem(item.id, { ready: 0 });
    await sync(pr());
    // GitHub recalculating mergeability on the same commit: not one either.
    await sync(pr({ mergeable: "UNKNOWN" }));
    await sync(pr());
    assert.equal(events(), 1);
    assert.equal(readyLogs(), 1);

    // A failing check ends the episode; passing again is a new one.
    await sync(pr({ checks: { total: 1, failed: 1, pending: false } }));
    await sync(pr());
    assert.equal(events(), 2);
    // A new commit passing the gate is a change too.
    await sync(pr({ head_sha: "def" }));
    assert.equal(events(), 3);
    // Closing forces the item flag to 1: no ready event.
    await sync(pr({ head_sha: "def", state: "CLOSED" }));
    assert.equal(events(), 3);
  } finally { db.close(); }
});
