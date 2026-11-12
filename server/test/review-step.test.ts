// Review step in the dispatch prompt: a named reviewer's command is resolved,
// {base_branch} substituted, the pre-pr-review skill appended, and the command
// frozen on the task.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { dispatchTask } from "../dispatch.ts";
import type { Config } from "../config.ts";
import type { WorkerBackend, WorkerStart, WorkerSession } from "../worker.ts";
import type { Task } from "../types.ts";

const MR = "https://gitlab.com/group/project/-/merge_requests/42";
const CUBIC = { name: "cubic", command: "cubic review --base {base_branch} --json" };

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Add caching", prompt: "Add caching", kind: "code", repo_path: "/tmp/repo",
    target: "claude", target_state: "suggested", base_branch: null, branch: null, worktree_path: null,
    assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null,
    status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now, ...over,
  };
}

function cfgWith(dir: string): Config {
  return { configDir: dir, host: "localhost", port: 4787, token: "", reviewers: [CUBIC] } as Config;
}

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

function withDb(fn: (db: Db, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-review-step-"));
    const db = new Db(join(dir, "test.db"));
    try {
      await fn(db, dir);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("dispatch: a reviewer appends the substituted review convention and freezes the command", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const task = makeTask({ repo_path: dir, base_branch: "main" });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await dispatchTask(db, cfgWith(dir), backend, task, "codex", { useWorktree: false, review: "cubic" });
  assert.equal(started.length, 1);
  const prompt = started[0].prompt;
  assert.match(prompt, /cubic review --base main --json/);
  assert.match(prompt, /Review your diff before opening the PR\/MR/);
  assert.doesNotMatch(prompt, /\{base_branch\}|\{review_command\}/);
  assert.equal(db.getTask(task.id)?.review, "cubic review --base main --json");
}));

test("dispatch: no reviewer leaves the prompt free of the pre-pr-review skill", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const task = makeTask({ repo_path: dir, base_branch: "main" });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await dispatchTask(db, cfgWith(dir), backend, task, "codex", { useWorktree: false });
  assert.doesNotMatch(started[0].prompt, /Review your diff before opening|Stop after two rounds/);
  assert.equal(db.getTask(task.id)?.review ?? null, null);
}));

test("dispatch: a review-kind task never gets the pre-pr-review skill", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const task = makeTask({ kind: "review", pr_url: MR, repo_path: dir, target: "claude" });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  const home = process.env.HOME;
  process.env.HOME = dir;
  try {
    await dispatchTask(db, cfgWith(dir), backend, task, "claude", { useWorktree: true, review: "cubic" });
  } finally {
    process.env.HOME = home;
  }
  assert.match(started[0].prompt, /fabien-reviewer/);
  assert.doesNotMatch(started[0].prompt, /Review your diff before opening|Stop after two rounds/);
  assert.equal(db.getTask(task.id)?.review ?? null, null);
}));

test("dispatch: an unknown reviewer fails before the backend starts", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const task = makeTask({ repo_path: dir, base_branch: "main" });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await assert.rejects(
    dispatchTask(db, cfgWith(dir), backend, task, "codex", { useWorktree: false, review: "nope" }),
    /unknown reviewer: nope/,
  );
  assert.equal(started.length, 0);
}));

test("dispatch: {base_branch} resolves the remote default branch when unset", withDb(async (db, dir) => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = join(dir, "remote.git"), source = join(dir, "source"), clone = join(dir, "clone");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  execFileSync("git", ["clone", remote, source], { stdio: "ignore" });
  git(source, "config", "user.email", "test@example.com");
  git(source, "config", "user.name", "Test");
  git(source, "config", "commit.gpgsign", "false");
  git(source, "commit", "--allow-empty", "-m", "initial");
  git(source, "push", "-u", "origin", "main");
  execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
  const task = makeTask({ repo_path: clone, base_branch: null });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await dispatchTask(db, cfgWith(dir), backend, task, "codex", { review: "cubic" });
  assert.match(started[0].prompt, /cubic review --base main --json/);
  assert.equal(db.getTask(task.id)?.review, "cubic review --base main --json");
}));

test("dispatch: {base_branch} becomes empty when unset and there is no remote", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const task = makeTask({ repo_path: dir, base_branch: null });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await dispatchTask(db, cfgWith(dir), backend, task, "codex", { useWorktree: false, review: "cubic" });
  assert.doesNotMatch(started[0].prompt, /\{base_branch\}/);
  assert.match(started[0].prompt, /cubic review --base/);
}));
