// Unit tests for Corral's core pieces (no herdr required).
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { slugify, defaultBaseBranch, ensureWorktree, removeWorktree } from "../dispatch.ts";
import { addRepo, isGitRepo, jiraKeyPrefix, scanWorkspaceRepos } from "../repos.ts";
import { CaptureEngine } from "../capture.ts";
import { execFileSync } from "node:child_process";
import type { Item, Task } from "../types.ts";

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
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    ...over,
  };
}

test("slugify produces url-safe names", () => {
  assert.equal(slugify("Add caching layer!"), "add-caching-layer");
  assert.equal(slugify("  Résumé de la conférence  "), "resume-de-la-conference");
  assert.equal(slugify("!!!"), "task");
  assert.ok(slugify("x".repeat(100)).length <= 40);
});

test("db: task and item round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-test-"));
  try {
    const db = new Db(join(dir, "test.db"));
    const task = makeTask();
    db.insertTask(task);
    assert.equal(db.getTask("task-1")?.title, "Add caching");
    db.updateTask("task-1", { status: "dispatched", branch: "feat" });
    assert.equal(db.getTask("task-1")?.status, "dispatched");
    assert.equal(db.listTasks("dispatched").length, 1);

    const item: Item = {
      id: "item-1",
      kind: "question",
      status: "open",
      title: "needs you",
      summary: "",
      body: "tail",
      source_ref: "t9",
      task_id: "task-1",
      structured: 0,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      resolved_ms: null,
      snooze_until_ms: null,
    };
    db.insertItem(item);
    assert.equal(db.openQuestionItemForTerminal("t9")?.id, "item-1");
    db.updateItem("item-1", { status: "resolved", resolved_ms: Date.now() });
    assert.equal(db.openQuestionItemForTerminal("t9"), null);

    // Jira dedupe
    db.insertTask(makeTask({ id: "task-2", jira_key: "OPS-1" }));
    assert.equal(db.getTaskByJiraKey("OPS-1")?.id, "task-2");

    db.recordMetric("test.event", "ref", { a: 1 });
    assert.ok(db.metricSummary().some((m) => m.name === "test.event"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree: create, reuse and remove", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-wt-"));
  try {
    const repo = join(dir, "repo");
    const worktrees = join(dir, "worktrees");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", join(dir, "no-hooks")], { stdio: "ignore" });
    execFileSync("sh", ["-c", `echo hello > ${repo}/README.md`], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "ignore" });

    assert.equal(defaultBaseBranch(repo), "main"); // no origin, falls back to local main

    const wt = ensureWorktree(repo, "feat-x", "main", worktrees);
    assert.ok(wt.includes("feat-x"));
    const again = ensureWorktree(repo, "feat-x", "main", worktrees);
    assert.equal(again, wt); // idempotent

    // branch exists now
    const wt2 = ensureWorktree(repo, "feat-x", "main", worktrees);
    assert.equal(wt2, wt);

    removeWorktree(repo, wt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repos: registry, scan and jira prefix mapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-repos-"));
  try {
    // two fake repos under a workspace root, one nested one level deeper
    const root = join(dir, "workspace");
    for (const name of ["alpha", "team/beta"]) {
      const repo = join(root, name);
      execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    }
    const notRepo = join(root, "notes");
    execFileSync("mkdir", ["-p", notRepo], { stdio: "ignore" });

    const db = new Db(join(dir, "test.db"));
    assert.ok(isGitRepo(join(root, "alpha")));
    assert.ok(!isGitRepo(notRepo));

    const added = scanWorkspaceRepos(db, [root]);
    assert.equal(added.length, 2, "both repos found");
    assert.equal(db.listRepos().length, 2);
    assert.equal(scanWorkspaceRepos(db, [root]).length, 0, "idempotent rescan");

    const alpha = db.getRepoByPath(join(root, "alpha"))!;
    db.updateRepo(alpha.id, { jira_prefix: "ops" });
    assert.equal(db.getRepoByJiraPrefix(jiraKeyPrefix("OPS-123"))?.id, alpha.id, "prefix maps case-insensitively");
    assert.equal(jiraKeyPrefix("QOV-2138"), "QOV");
    assert.equal(jiraKeyPrefix("NOKEY"), "NOKEY");

    addRepo(db, join(root, "alpha"), { source: "scan" }); // duplicate path is ignored
    assert.equal(db.listRepos().length, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture: structured question supersedes fallback; auto-resolution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-cap-"));
  try {
    const db = new Db(join(dir, "test.db"));
    db.insertTask(makeTask());
    db.upsertTerminal({
      address: "t9",
      task_id: "task-1",
      name: "corral-test",
      agent: "claude",
      last_status: null,
      last_turn: 0,
      updated_ms: Date.now(),
    });
    const broadcasts: [string, unknown][] = [];
    const fakeHerdr = {
      readTerminal: async () => ({ text: "agent tail…", complete: true }),
      listTerminals: async () => ({ terminals: [], hidden_finished: 0, machines: [] }),
    };
    const engine = new CaptureEngine(db, fakeHerdr as never, {
      broadcast: (t: string, d: unknown) => broadcasts.push([t, d]),
    });

    // fallback capture on blocked
    await engine.handleEvent({
      type: "status",
      terminal: "t9",
      seq: 1,
      data: { status: { state: "blocked" } },
    });
    const fallback = db.openQuestionItemForTerminal("t9");
    assert.ok(fallback, "fallback item created");
    assert.equal(fallback.structured, 0);
    assert.equal(fallback.body, "agent tail…");
    assert.ok(broadcasts.some(([t]) => t === "item.created"));

    // structured report upgrades it
    const structured = engine.createStructuredQuestion({
      taskId: "task-1",
      terminal: "t9",
      title: "Use Postgres or SQLite?",
      body: "I recommend SQLite.",
    });
    assert.equal(structured.id, fallback.id, "supersedes the fallback item");
    assert.equal(structured.structured, 1);
    assert.equal(db.openQuestionItemForTerminal("t9")?.title, "Use Postgres or SQLite?");

    // leaving blocked auto-resolves
    await engine.handleEvent({
      type: "status",
      terminal: "t9",
      seq: 2,
      data: { status: { state: "working" } },
    });
    assert.equal(db.openQuestionItemForTerminal("t9"), null, "auto-resolved");

    // finished marks the task done
    await engine.handleEvent({
      type: "finished",
      terminal: "t9",
      seq: 3,
      data: { exit_code: 0, reason: "exited" },
    });
    assert.equal(db.getTask("task-1")?.status, "done");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
