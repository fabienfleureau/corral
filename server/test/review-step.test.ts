// Review step in the dispatch prompt: a named reviewer's command is resolved,
// {base_branch} substituted, the pre-pr-review skill appended, and the command
// frozen on the task.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { dispatchTask } from "../dispatch.ts";
import { createHttpServer, type AppState } from "../api.ts";
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

test("dispatch: a review command's $ sequences survive substitution verbatim", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  // `$$`, `$&`, `$'` and `` $` `` are replacement patterns for String.replaceAll:
  // they must reach the prompt and the stored task exactly as the user wrote them.
  const command = "cubic review --base {base_branch} --id $$ --grep $& --label $'x' --tick $`y`";
  const expected = "cubic review --base main --id $$ --grep $& --label $'x' --tick $`y`";
  const task = makeTask({ repo_path: dir, base_branch: "main" });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  const cfg = { ...cfgWith(dir), reviewers: [{ name: "odd", command }] } as Config;
  await dispatchTask(db, cfg, backend, task, "codex", { useWorktree: false, review: "odd" });
  assert.ok(started[0].prompt.includes(expected), "prompt must carry the command verbatim");
  assert.equal(db.getTask(task.id)?.review, expected);
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

test("interview modes dispatch the selected skill and isolate documentation changes", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"], { stdio: "ignore" });
  const { backend, started } = fakeBackend();
  for (const kind of ["grill", "grill-docs"] as const) {
    const task = makeTask({ id: kind, kind, repo_path: dir });
    db.insertTask(task);
    await dispatchTask(db, cfgWith(dir), backend, task, "codex", { useWorktree: false });
    const prompt = started.at(-1)!.prompt;
    assert.match(prompt, new RegExp(`Interview mode: \\*\\*${kind === "grill" ? "discussion" : "documentation"}\\*\\*`));
    assert.match(prompt, /complete round as a single question report/);
    assert.match(prompt, new RegExp(`Documentation output: \\*\\*${kind === "grill" ? "the working folder" : "a git worktree"}`));
    assert.equal(started.at(-1)!.git === null, kind === "grill");
  }
}));

test("interview tasks accept a folder; docs run in place without a PR loop", withDb(async (db, dir) => {
  const folder = join(dir, "notes");
  mkdirSync(folder);
  const { backend, started } = fakeBackend();
  for (const kind of ["grill", "grill-docs"] as const) {
    const task = makeTask({ id: `folder-${kind}`, kind, repo_path: folder });
    db.insertTask(task);
    await dispatchTask(db, cfgWith(dir), backend, task, "codex", { useWorktree: true });
    const session = started.at(-1)!;
    assert.equal(session.git, null);
    assert.match(session.prompt, /# Corral action task/);
    assert.doesNotMatch(session.prompt, /# The PR loop/);
    assert.equal(db.getTask(task.id)?.branch, null);
  }
  const docsPrompt = started.at(-1)!.prompt;
  assert.match(docsPrompt, /Interview mode: \*\*documentation\*\*/);
  assert.match(docsPrompt, /Documentation output: \*\*the working folder/);
}));

const OCR_CODEX = { name: "ocr-codex", delegate: "codex" } as const;

function cfgDelegate(dir: string): Config {
  return { configDir: dir, host: "localhost", port: 4787, token: "", reviewers: [CUBIC, OCR_CODEX] } as Config;
}

test("dispatch: a delegate reviewer passes the sub-agent to the backend and the delegate review step to the prompt", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const task = makeTask({ repo_path: dir, base_branch: "main" });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await dispatchTask(db, cfgDelegate(dir), backend, task, "claude", { useWorktree: false, review: "ocr-codex" });
  assert.equal(started.length, 1);
  const { prompt, delegates, agent } = started[0];
  assert.deepEqual(delegates, [{ name: "ocr_codex", harness: "codex", prompt: readFileSync("skills/ocr-delegate.md", "utf8") }]);
  assert.equal(agent, null);
  // The parent is told to call the sub-agent, with the resolved base ref, and never to run a command.
  assert.match(prompt, /`ocr_codex` sub-agent/);
  assert.match(prompt, /sys_session_send/);
  assert.match(prompt, /Base ref: main/);
  assert.doesNotMatch(prompt, /\{base_branch\}|\{review_agent\}|\{review_command\}|Run the review from the worktree root/);
  assert.equal(db.getTask(task.id)?.review, "sub-agent ocr_codex");
}));

test("dispatch: a delegate review step with no known base branch asks for an empty base ref", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const task = makeTask({ repo_path: dir, base_branch: null });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await dispatchTask(db, cfgDelegate(dir), backend, task, "claude", { useWorktree: false, review: "ocr-codex" });
  assert.match(started[0].prompt, /Base ref: "/);
}));

test("dispatch: a delegate reviewer is refused off the claude harness or with an explicit agent, before the backend starts", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const task = makeTask({ repo_path: dir, base_branch: "main" });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await assert.rejects(
    dispatchTask(db, cfgDelegate(dir), backend, task, "codex", { useWorktree: false, review: "ocr-codex" }),
    /claude harness \(got codex\)/,
  );
  await assert.rejects(
    dispatchTask(db, cfgDelegate(dir), backend, task, "claude", { useWorktree: false, review: "ocr-codex", agent: "my-agent" }),
    /explicit agent/,
  );
  assert.equal(started.length, 0);
  assert.equal(db.getTask(task.id)?.review ?? null, null);
}));

test("dispatch: a command reviewer sends no delegates and still runs on any harness or agent", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  const task = makeTask({ repo_path: dir, base_branch: "main" });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await dispatchTask(db, cfgDelegate(dir), backend, task, "codex", { useWorktree: false, review: "cubic", agent: "my-agent" });
  assert.equal(started[0].delegates, undefined);
  assert.equal(started[0].agent, "my-agent");
  assert.doesNotMatch(started[0].prompt, /sys_session_send/);
}));

test("dispatch: the user's copy of the delegate skills in the config dir wins over the shipped ones", withDb(async (db, dir) => {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  mkdirSync(join(dir, "skills"));
  writeFileSync(join(dir, "skills", "ocr-delegate.md"), "CUSTOM CHILD PROMPT");
  writeFileSync(join(dir, "skills", "pre-pr-delegate-review.md"), "CUSTOM PARENT STEP for {review_agent} against {base_branch}");
  const task = makeTask({ repo_path: dir, base_branch: "main" });
  db.insertTask(task);
  const { backend, started } = fakeBackend();
  await dispatchTask(db, cfgDelegate(dir), backend, task, "claude", { useWorktree: false, review: "ocr-codex" });
  assert.equal(started[0].delegates?.[0].prompt, "CUSTOM CHILD PROMPT");
  assert.match(started[0].prompt, /CUSTOM PARENT STEP for ocr_codex against main/);
}));

test("api: a delegate reviewer on another harness or an explicit agent is a 400, not a failed dispatch", withDb(async (db, dir) => {
  const { backend, started } = fakeBackend();
  const server = createHttpServer({ db, backend, hub: { broadcast: () => undefined }, cfg: { token: "test", configDir: dir, reviewers: [CUBIC, OCR_CODEX] } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const created = await (await call("POST", "/api/tasks", { prompt: "x", repo_path: dir })).json() as Task;
    const wrongHarness = await call("POST", `/api/tasks/${created.id}/dispatch`, { target: "codex", review: "ocr-codex" });
    assert.equal(wrongHarness.status, 400);
    assert.match((await wrongHarness.json() as { error: string }).error, /claude harness/);
    const withAgent = await call("POST", `/api/tasks/${created.id}/dispatch`, { target: "claude", agent: "my-agent", review: "ocr-codex" });
    assert.equal(withAgent.status, 400);
    assert.match((await withAgent.json() as { error: string }).error, /explicit agent/);
    assert.equal(started.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));

test("dispatch: delegate reviewer diffs against freshly fetched origin/<base> when origin exists", withDb(async (db, dir) => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = join(dir, "remote.git"), source = join(dir, "source"), clone = join(dir, "clone");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  execFileSync("git", ["clone", remote, source], { stdio: "ignore" });
  for (const repo of [source]) {
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "commit.gpgsign", "false");
  }
  git(source, "commit", "--allow-empty", "-m", "initial");
  git(source, "push", "-u", "origin", "main");
  execFileSync("git", ["clone", remote, clone], { stdio: "ignore" });
  const staleMain = git(clone, "rev-parse", "main");
  git(source, "commit", "--allow-empty", "-m", "newer on origin");
  git(source, "push", "origin", "main");
  const latestMain = git(source, "rev-parse", "HEAD");
  assert.notEqual(staleMain, latestMain);

  const { backend, started } = fakeBackend();
  const unset = makeTask({ id: "unset", repo_path: clone, base_branch: null });
  const pinnedBare = makeTask({ id: "bare", repo_path: clone, base_branch: "main" });
  const pinnedRemote = makeTask({ id: "remote", repo_path: clone, base_branch: "origin/main" });
  for (const task of [unset, pinnedBare, pinnedRemote]) {
    db.insertTask(task);
    await dispatchTask(db, cfgDelegate(dir), backend, task, "claude", { review: "ocr-codex" });
  }
  assert.match(started[0].prompt, /Base ref: origin\/main/);
  assert.match(started[1].prompt, /Base ref: origin\/main/);
  assert.match(started[2].prompt, /Base ref: origin\/main/);
  assert.doesNotMatch(started[2].prompt, /origin\/origin\/main/);
  assert.equal(git(clone, "rev-parse", "origin/main"), latestMain);
  assert.equal(git(clone, "rev-parse", "main"), staleMain);
}));

test("dispatch: delegate reviewer fetches custom base branch in single-branch clone and keeps local-only refs", withDb(async (db, dir) => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  git(clone, "branch", "local-wip");

  const { backend, started } = fakeBackend();
  const customTask = makeTask({ id: "custom", repo_path: clone, base_branch: "feature/custom" });
  db.insertTask(customTask);
  await dispatchTask(db, cfgDelegate(dir), backend, customTask, "claude", { review: "ocr-codex" });
  assert.match(started[0].prompt, /Base ref: origin\/feature\/custom/);
  assert.equal(git(clone, "rev-parse", "--verify", "refs/remotes/origin/feature/custom"), expected);
  assert.equal(started[0].git?.base, expected);

  const localTask = makeTask({ id: "local", repo_path: clone, base_branch: "local-wip" });
  db.insertTask(localTask);
  await dispatchTask(db, cfgDelegate(dir), backend, localTask, "claude", { useWorktree: false, review: "ocr-codex" });
  assert.match(started[1].prompt, /Base ref: local-wip/);
}));

test("ocr-delegate skill prefers origin/<base>, reviews unsupported_ext docs, and skips rule when empty", () => {
  const ocrSkill = readFileSync(join(process.cwd(), "skills", "ocr-delegate.md"), "utf8");
  assert.match(ocrSkill, /origin\/<base>/);
  assert.match(ocrSkill, /unsupported_ext/);
  assert.match(ocrSkill, /Markdown/i);
  assert.match(ocrSkill, /skip this command when `reviewable_files` is empty/i);
});
