// Unit tests for Corral's core pieces (worker-free: fakes for the backend).
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { slugify } from "../dispatch.ts";
import { addRepo, importFingerprint, importPreview, isGitRepo, jiraKeyPrefix, scanWorkspaceRepos } from "../repos.ts";
import { prReady, prItemBody, syncTaskPr, type PrInfo } from "../pr.ts";
import { CaptureEngine } from "../capture.ts";
import type {
  WorkerBackend,
  WorkerElicitation,
  WorkerEvent,
  WorkerStart,
  WorkerSession,
} from "../worker.ts";
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
    pr_url: null,
    pr_meta: null,
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    ...over,
  };
}

/** Minimal in-memory WorkerBackend for capture tests. */
function fakeBackend(readText = "agent tail…") {
  const started: WorkerStart[] = [];
  const sent: { address: string; text: string }[] = [];
  const backend: WorkerBackend = {
    name: "fake",
    async start(s: WorkerStart): Promise<WorkerSession> {
      started.push(s);
      return {
        address: "s1",
        task_id: s.taskId,
        name: s.name,
        harness: s.harness,
        status: "working",
        blocked_kind: null,
        state: "live",
        turn: 1,
        cwd: s.git ? `${s.repoPath}-worktrees/${s.git.branch}` : s.repoPath,
        created_ms: Date.now(),
        exit_code: null,
        parent: null,
      };
    },
    list: async () => [],
    get: async () => null,
    read: async () => readText,
    send: async (address, text) => {
      sent.push({ address, text });
    },
    resolveElicitation: async () => undefined,
    kill: async () => undefined,
    history: async () => readText,
    tree: async () => [],
    onEvent: () => ({ stop: () => undefined }),
  };
  return { backend, started, sent };
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
    db.updateTask("task-1", { status: "dispatched", branch: "feat", handoff: "did things" });
    assert.equal(db.getTask("task-1")?.status, "dispatched");
    assert.equal(db.getTask("task-1")?.handoff, "did things");
    assert.equal(db.listTasks("dispatched").length, 1);

    const item: Item = {
      id: "item-1",
      kind: "question",
      status: "open",
      title: "needs you",
      summary: "",
      body: "tail",
      context: "",
      options: null,
      ready: 1,
      source_ref: "s9",
      task_id: "task-1",
      structured: 0,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      resolved_ms: null,
      snooze_until_ms: null,
    };
    db.insertItem(item);
    assert.equal(db.openQuestionItemForTerminal("s9")?.id, "item-1");
    db.updateItem("item-1", { status: "resolved", resolved_ms: Date.now() });
    assert.equal(db.openQuestionItemForTerminal("s9"), null);

    db.insertTask(makeTask({ id: "task-2", jira_key: "OPS-1" }));
    assert.equal(db.getTaskByJiraKey("OPS-1")?.id, "task-2");

    db.recordMetric("test.event", "ref", { a: 1 });
    assert.ok(db.metricSummary().some((m) => m.name === "test.event"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repos: registry, scan and jira prefix mapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-repos-"));
  try {
    const root = join(dir, "workspace");
    for (const name of ["alpha", "team/beta"]) {
      const repo = join(root, name);
      mkdirSync(join(root, "team"), { recursive: true });
      execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
    }
    const notRepo = join(root, "notes");
    mkdirSync(notRepo, { recursive: true });

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

    // import preview: mapped prefix, unmapped prefix, already imported
    assert.deepEqual(importPreview(db, "OPS-7"), {
      repo_path: alpha.path,
      repo_name: alpha.name,
      existing_task_id: null,
    });
    assert.deepEqual(importPreview(db, "QOV-1"), { repo_path: null, repo_name: null, existing_task_id: null });
    db.insertTask(makeTask({ id: "task-ops-8", jira_key: "OPS-8" }));
    assert.equal(importPreview(db, "OPS-8").existing_task_id, "task-ops-8");

    // fingerprint: stable for the same fields, changes with prompt or repo
    const fields = { title: "OPS-7 Fix", prompt: "Do it", jira_parent_key: null, repo_path: alpha.path };
    assert.equal(importFingerprint(fields), importFingerprint({ ...fields }));
    assert.notEqual(importFingerprint(fields), importFingerprint({ ...fields, prompt: "Do it now" }));
    assert.notEqual(importFingerprint(fields), importFingerprint({ ...fields, repo_path: null }));

    addRepo(db, join(root, "alpha"), { source: "scan" }); // duplicate path is ignored
    assert.equal(db.listRepos().length, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr gate: ready only when threads answered, checks green, mergeable", () => {
  const base: PrInfo = {
    url: "https://example.com/pr/1",
    title: "feat: thing",
    state: "OPEN",
    number: 1,
    description: "Does a thing.",
    additions: 10,
    deletions: 2,
    changed_files: 3,
    mergeable: "MERGEABLE",
    review_decision: null,
    checks: { total: 2, failed: 0, pending: false },
    threads: [],
  };

  assert.equal(prReady(base).ready, true, "clean PR is ready");

  const withComments = { ...base, threads: [{ id: "t1", author: "copilot", body: "fix this" }] };
  const r1 = prReady(withComments);
  assert.equal(r1.ready, false);
  assert.match(r1.reasons.join(), /1 unresolved review comment/);

  assert.match(prReady({ ...base, checks: { total: 2, failed: 1, pending: false } }).reasons.join(), /1 failing check/);
  assert.match(prReady({ ...base, checks: { total: 2, failed: 0, pending: true } }).reasons.join(), /checks still running/);
  assert.match(prReady({ ...base, mergeable: "CONFLICTING" }).reasons.join(), /merge conflicts/);
  assert.equal(prReady({ ...base, state: "MERGED" }).ready, false);

  const body = prItemBody(base);
  assert.match(body, /Does a thing\./);
  assert.match(body, /\+10 \/ -2/);
  assert.match(body, /https:\/\/example\.com\/pr\/1/);
});

test("capture: elicitation, fallback, auto-resolution, completion handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-cap-"));
  try {
    const db = new Db(join(dir, "test.db"));
    db.insertTask(makeTask());
    db.upsertTerminal({
      address: "s9",
      task_id: "task-1",
      name: "corral-test",
      agent: "claude",
      last_status: null,
      last_turn: 0,
      updated_ms: Date.now(),
    });
    const broadcasts: [string, unknown][] = [];
    const { backend } = fakeBackend();
    const engine = new CaptureEngine(db, backend, {
      broadcast: (t: string, d: unknown) => broadcasts.push([t, d]),
    });

    // blocked WITH an elicitation -> structured question item with options
    const elicit: WorkerElicitation = {
      id: "el1",
      kind: "permission",
      prompt: "Allow running tests?",
      choices: ["yes", "no"],
    };
    await engine.handleEvent({
      type: "status",
      address: "s9",
      status: "blocked",
      elicitations: [elicit],
    });
    const item = db.openQuestionItemForTerminal("s9");
    assert.ok(item, "elicitation item created");
    assert.equal(item.structured, 1);
    assert.equal(item.options, JSON.stringify(["yes", "no"]));
    assert.match(item.body, /Allow running tests\?/);

    // a structured report supersedes it
    const structured = await engine.createStructuredQuestion({
      taskId: "task-1",
      terminal: "s9",
      title: "Use Postgres or SQLite?",
      body: "I recommend SQLite.",
      options: ["SQLite", "Postgres", "none"],
    });
    assert.equal(structured.id, item.id, "supersedes the pending item");
    assert.equal(structured.options, JSON.stringify(["SQLite", "Postgres", "none"]));

    // leaving blocked auto-resolves
    await engine.handleEvent({ type: "status", address: "s9", status: "idle" });
    assert.equal(db.openQuestionItemForTerminal("s9"), null, "auto-resolved");

    // completion report: pr item + task done + handoff stored
    const done = await engine.createStructuredQuestion({
      kind: "done",
      taskId: "task-1",
      terminal: "s9",
      title: "PR: add caching",
      body: "Done, tests pass.\n\nPR: https://example.com/pr/1\n\n## Handoff\nBranch is clean; keep tests green.",
    });
    assert.equal(done.kind, "pr");
    const task = db.getTask("task-1")!;
    assert.equal(task.status, "done", "task marked done by the completion report");
    assert.match(task.handoff ?? "", /keep tests green/);

    // fallback path (no elicitation): raw tail
    await engine.handleEvent({ type: "status", address: "s9", status: "blocked", elicitations: [] });
    const fallback = db.openQuestionItemForTerminal("s9");
    assert.ok(fallback);
    assert.equal(fallback.structured, 0);
    assert.equal(fallback.body, "agent tail…");
    assert.ok(broadcasts.some(([t]) => t === "item.created"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr sync: item flips ready->needs work and back, resolves on merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-prsync-"));
  try {
    const db = new Db(join(dir, "test.db"));
    db.insertTask(makeTask({ branch: "feat-x", status: "dispatched", repo_path: "/tmp/repo" }));
    const hub = { broadcast: () => undefined };

    let current: PrInfo = {
      url: "https://example.com/pr/7",
      title: "feat: x",
      state: "OPEN",
      number: 7,
      description: "x",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      mergeable: "MERGEABLE",
      review_decision: null,
      checks: { total: 1, failed: 0, pending: false },
      threads: [],
    };
    const finder = () => current;
    syncTaskPr(db, hub, makeTask({ branch: "feat-x", status: "dispatched", repo_path: "/tmp/repo", id: "task-1" }), { finder });
    let item = db.listItems({ kind: "pr" })[0];
    assert.equal(item.ready, 1);
    assert.match(item.title, /PR ready for review/);

    current = { ...current, threads: [{ id: "t1", author: "bot", body: "fix" }] };
    syncTaskPr(db, hub, db.getTask("task-1")!, { finder });
    item = db.listItems({ kind: "pr" })[0];
    assert.equal(item.ready, 0);
    assert.match(item.title, /PR needs work/);
    assert.match(item.summary, /1 unresolved review comment/);

    current = { ...current, state: "MERGED", threads: [] };
    syncTaskPr(db, hub, db.getTask("task-1")!, { finder });
    item = db.listItems({ kind: "pr" })[0];
    assert.equal(item.status, "resolved");
    assert.match(item.title, /PR merged/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture: untitled task adopts the omnigent session title, titled task keeps its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-test-"));
  try {
    const db = new Db(join(dir, "test.db"));
    db.insertTask(makeTask({ title: "", prompt: "Fix the flaky login test\nmore context", terminal_address: "s1" }));
    db.insertTask(makeTask({ id: "task-2", title: "Mine", terminal_address: "s2" }));
    const { backend } = fakeBackend();
    const engine = new CaptureEngine(db, backend, { broadcast: () => undefined });

    // no title yet -> stays untitled
    await engine.handleEvent({ type: "created", address: "s1", task_id: "task-1", status: "working", title: null });
    assert.equal(db.getTask("task-1")?.title, "");

    await engine.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "working", title: "Fix flaky login test" });
    assert.equal(db.getTask("task-1")?.title, "Fix flaky login test");

    await engine.handleEvent({ type: "status", address: "s2", task_id: "task-2", status: "working", title: "Other" });
    assert.equal(db.getTask("task-2")?.title, "Mine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
