// Starting an epic task is an explicit action on the Epic page: the route
// rechecks readiness, stacks the branch and cleans up older inbox items.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer, type AppState } from "../api.ts";
import type { Config } from "../config.ts";
import { Db } from "../db.ts";
import type { Favorite } from "../favorites.ts";
import { reviewSummary, type Reviewer } from "../reviewers.ts";
import type { Item, Repo, Task } from "../types.ts";
import type { WorkerBackend, WorkerSession, WorkerStart } from "../worker.ts";

function fakeBackend(started: WorkerStart[]): WorkerBackend {
  return {
    name: "fake",
    async start(s: WorkerStart): Promise<WorkerSession> {
      started.push(s);
      return {
        address: `session-${started.length}`, task_id: s.taskId, name: s.name, harness: s.harness,
        status: "working", blocked_kind: null, state: "live", turn: 1, cwd: s.repoPath,
        created_ms: Date.now(), exit_code: null, parent: null,
      };
    },
    list: async () => [], get: async () => null, read: async () => "", send: async () => undefined,
    resolveElicitation: async () => undefined, kill: async () => undefined, history: async () => "",
    tree: async () => [], onEvent: () => ({ stop: () => undefined }),
  } as unknown as WorkerBackend;
}

test("epic launch: only a ready task starts, from the Epic page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-launch-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"]);
  execFileSync("git", ["-C", dir, "branch", "feat/e1"]);
  const db = new Db(":memory:");
  const started: WorkerStart[] = [];
  const server = createHttpServer({
    db,
    cfg: { token: "test", configDir: dir, host: "localhost", port: 4787 } as Config,
    backend: fakeBackend(started),
    hub: { broadcast() { /* no clients */ } },
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string) => {
    const res = await fetch(url + path, {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: "{}",
    });
    return { status: res.status, body: await res.json() as { error?: string } };
  };
  const get = async (path: string) => {
    const res = await fetch(url + path, { headers: { Authorization: "Bearer test" } });
    return { status: res.status, body: await res.json() as { tasks: { id: string }[]; views: { task: { id: string } }[] } };
  };
  try {
    const now = Date.now();
    db.insertEpic({ id: "e", jira_key: "E-1", title: "E", description: "", error: null, synced_ms: now, created_ms: now });
    const task = (id: string, over: Partial<Task> = {}): Task => ({
      id, title: `${id} t`, prompt: "work", repo_path: dir, target: "codex", target_state: "confirmed",
      base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: id,
      jira_url: null, jira_parent_key: null, jira_status: null, pr_url: null, pr_meta: null,
      status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now,
      epic_id: "e", epic_out: 0, ...over,
    });
    db.insertTask(task("E-1", { status: "dispatched", branch: "feat/e1", terminal_address: "s0", pr_url: "u" }));
    db.insertTask(task("E-2"));
    db.insertTask(task("E-3"));
    db.insertTask(task("E-4", { jira_status: "Killed" }));
    db.insertTask(task("request-1", { jira_key: null, title: "Draft release notes" }));
    db.replaceEpicLinks("e", [
      { task_key: "E-2", blocked_by_key: "E-1" },
      { task_key: "E-3", blocked_by_key: "E-2" },
    ]);
    const pr: Item = {
      id: "pr-e1", kind: "pr", status: "open", title: "", summary: "", body: "", context: "", options: null,
      ready: 1, handling: 0, source_ref: null, task_id: "E-1", structured: 1,
      created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null,
    };
    db.insertItem(pr);
    const legacy: Item = {
      ...pr, id: "old-launch", kind: "launch", task_id: "E-2", title: "Ready to launch: E-2 t",
    };
    db.insertItem(legacy);

    const detail = await get("/api/epics/e");
    assert.equal(detail.status, 200);
    assert.ok(!detail.body.tasks.some((t) => t.id === "request-1"), "a prompt task is not board data");
    assert.ok(!detail.body.views.some((v) => v.task.id === "request-1"), "a prompt task is not a board view");

    assert.equal(db.listItems({ kind: "launch" }).filter((i) => i.status === "open").length, 1, "only the legacy item exists");
    const notJira = await post("/api/epics/e/tasks/request-1/launch");
    assert.equal(notJira.status, 409);
    assert.match(notJira.body.error ?? "", /Jira/);
    assert.equal(started.length, 0, "a prompt task never launches from the epic");

    const blocked = await post("/api/epics/e/tasks/E-3/launch");
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error ?? "", /blocked/);
    assert.equal(started.length, 0, "a blocked task never starts");

    const killed = await post("/api/epics/e/tasks/E-4/launch");
    assert.equal(killed.status, 409);
    assert.match(killed.body.error ?? "", /killed/);
    assert.equal(started.length, 0, "a killed ticket never launches");

    const launched = await post("/api/epics/e/tasks/E-2/launch");
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    assert.equal(started.length, 1);
    assert.equal(db.getTask("E-2")!.status, "dispatched");
    assert.equal(db.getTask("E-2")!.base_branch, "feat/e1");
    assert.equal(started[0].git?.base, execFileSync("git", ["-C", dir, "rev-parse", "feat/e1"]).toString().trim());
    assert.equal(db.getItem(legacy.id)!.status, "archived", "old inbox item is cleaned up on launch");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epic launch and dispatch run tasks with the epic's designated favorite conf and allow per-task overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-fav-launch-"));
  const workDir = join(dir, "work");
  const homeDir = join(dir, "home");
  execFileSync("git", ["init", "-q", workDir]);
  execFileSync("git", ["-C", workDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"]);
  execFileSync("git", ["init", "-q", homeDir]);
  execFileSync("git", ["-C", homeDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"]);

  const db = new Db(":memory:");
  const started: WorkerStart[] = [];
  const favorites: Favorite[] = [
    { name: "WorkFav", harness: "claude", agent: "worker", model: "opus", reasoning: "high", context: "professional", review: "cubic" },
    { name: "DelegateFav", harness: "claude", agent: "", model: "sonnet", reasoning: "medium", context: "professional", review: "ocr-codex" },
  ];
  const reviewers: Reviewer[] = [
    { name: "cubic", command: "cubic review --base {base_branch}" },
    { name: "ocr-codex", delegate: "codex" },
  ];
  const workRepo: Repo = { id: "w", name: "work", path: workDir, jira_prefix: null, context: null, source: "manual", created_ms: 0 };
  const homeRepo: Repo = { id: "h", name: "home", path: homeDir, jira_prefix: null, context: "personal", source: "manual", created_ms: 0 };

  const server = createHttpServer({
    db,
    cfg: {
      token: "test",
      configDir: dir,
      host: "localhost",
      port: 4787,
      favorites,
      reviewers,
      agents: { claude: ["claude"], codex: ["codex"] },
    } as unknown as Config,
    backend: fakeBackend(started),
    hub: { broadcast() { /* no clients */ } },
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  try {
    const now = Date.now();
    db.insertRepo(workRepo);
    db.insertRepo(homeRepo);
    db.insertEpic({ id: "e", jira_key: "E-1", title: "E", description: "", error: null, favorite_name: "WorkFav", repo_path: workDir, synced_ms: now, created_ms: now });

    const makeTask = (id: string, over: Partial<Task> = {}): Task => ({
      id, title: `${id} t`, prompt: "work", kind: "code", repo_path: workDir, target: "", target_state: "suggested",
      agent: null, model: null, reasoning: null, review: null, base_branch: null, branch: null, worktree_path: null,
      assignee: null, jira_key: id, jira_url: null, jira_parent_key: null, jira_status: null, pr_url: null, pr_meta: null,
      status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now, epic_id: "e", epic_out: 0,
      ...over,
    });

    db.insertTask(makeTask("E-1"));
    db.insertTask(makeTask("E-2", { repo_path: homeDir }));
    db.insertTask(makeTask("E-3", { target: "codex", model: "gpt-6", reasoning: "low", review: reviewSummary(reviewers[0]) }));
    db.insertTask(makeTask("E-4", { jira_key: null, kind: "ops" }));
    db.insertTask(makeTask("E-5", { repo_path: "" }));

    // 1. Launching a ready task without an explicit harness uses the epic's designated favorite (including review).
    const l1 = await req("POST", "/api/epics/e/tasks/E-1/launch", {});
    assert.equal(l1.status, 200, JSON.stringify(l1.body));
    assert.equal(started[0].harness, "claude");
    assert.equal(started[0].agent, "worker");
    assert.equal(started[0].model, "opus");
    assert.equal(started[0].reasoning, "high");
    assert.match(started[0].prompt, /cubic review --base/);
    const stored1 = db.getTask("E-1")!;
    assert.equal(stored1.target, "claude");
    assert.equal(stored1.agent, "worker");
    assert.equal(stored1.model, "opus");
    assert.equal(stored1.reasoning, "high");
    assert.equal(stored1.review, "cubic review --base ");

    // 2. Launching a task whose repo context does not match the epic favorite fails with 400.
    const l2 = await req("POST", "/api/epics/e/tasks/E-2/launch", {});
    assert.equal(l2.status, 400);
    assert.match(l2.body.error ?? "", /WorkFav/);

    // 3. Explicit per-task settings win over the epic favorite, and keep compatible task.review.
    const l3 = await req("POST", "/api/epics/e/tasks/E-3/launch", {});
    assert.equal(l3.status, 200, JSON.stringify(l3.body));
    assert.equal(started[1].harness, "codex");
    assert.equal(started[1].agent, null);
    assert.equal(started[1].model, "gpt-6");
    assert.equal(started[1].reasoning, "low");
    assert.match(started[1].prompt, /cubic review --base/);

    // 4. Dispatching a non-Jira epic task via POST /api/tasks/:id/dispatch falls back to the epic favorite.
    const d4 = await req("POST", "/api/tasks/E-4/dispatch", {});
    assert.equal(d4.status, 200, JSON.stringify(d4.body));
    assert.equal(started[2].harness, "claude");
    assert.equal(started[2].agent, "worker");
    assert.equal(started[2].model, "opus");
    assert.equal(started[2].reasoning, "high");

    // 5. Assigning a compatible repo via PATCH /api/tasks/:id on an unconfigured open epic task inherits the epic favorite.
    const p5 = await req("PATCH", "/api/tasks/E-5", { repo_path: workDir });
    assert.equal(p5.status, 200, JSON.stringify(p5.body));
    assert.equal(p5.body.target, "claude");
    assert.equal(p5.body.agent, "worker");
    assert.equal(p5.body.model, "opus");
    assert.equal(p5.body.reasoning, "high");
    assert.equal(p5.body.review, reviewSummary(reviewers[0]));

    // 6. Delegate reviewer on the epic favorite spawns the delegate sub-agent at launch.
    const switchFav = await req("PATCH", "/api/epics/e", { favorite_name: "DelegateFav" });
    assert.equal(switchFav.status, 200);
    assert.equal(db.getTask("E-5")!.review, "sub-agent ocr_codex");
    const l5 = await req("POST", "/api/epics/e/tasks/E-5/launch", {});
    assert.equal(l5.status, 200, JSON.stringify(l5.body));
    assert.equal(started[3].harness, "claude");
    assert.equal(started[3].agent, null);
    assert.equal(started[3].model, "sonnet");
    assert.equal(started[3].reasoning, "medium");
    assert.equal(started[3].delegates?.[0]?.name, "ocr_codex");
    assert.equal(started[3].delegates?.[0]?.harness, "codex");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epic ticket launch: pick repo (and favorite/target) to create and dispatch from a synced Jira ticket, and launch ready tasks with inline repo/conf", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-ticket-launch-"));
  const workDir = join(dir, "work");
  const homeDir = join(dir, "home");
  execFileSync("git", ["init", "-q", workDir]);
  execFileSync("git", ["-C", workDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"]);
  execFileSync("git", ["-C", workDir, "branch", "feat/e1"]);
  execFileSync("git", ["init", "-q", homeDir]);
  execFileSync("git", ["-C", homeDir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"]);

  const db = new Db(":memory:");
  const started: WorkerStart[] = [];
  let failNextStart = false;
  const backend: WorkerBackend = {
    ...fakeBackend(started),
    async start(s: WorkerStart): Promise<WorkerSession> {
      if (failNextStart) {
        failNextStart = false;
        throw new Error("omnigent unavailable");
      }
      started.push(s);
      return {
        address: `session-${started.length}`, task_id: s.taskId, name: s.name, harness: s.harness,
        status: "working", blocked_kind: null, state: "live", turn: 1, cwd: s.repoPath,
        created_ms: Date.now(), exit_code: null, parent: null,
      };
    },
  };
  const favorites: Favorite[] = [
    { name: "WorkFav", harness: "claude", agent: "worker", model: "opus", reasoning: "high", context: "professional", review: "cubic" },
    { name: "HomeFav", harness: "codex", agent: "", model: "gpt-5", reasoning: "medium", context: "personal", review: "" },
  ];
  const reviewers: Reviewer[] = [{ name: "cubic", command: "cubic review --base {base_branch}" }];
  const workRepo: Repo = { id: "w", name: "work", path: workDir, jira_prefix: null, context: null, source: "manual", created_ms: 0 };
  const homeRepo: Repo = { id: "h", name: "home", path: homeDir, jira_prefix: null, context: "personal", source: "manual", created_ms: 0 };

  const server = createHttpServer({
    db,
    cfg: {
      token: "test",
      configDir: dir,
      host: "localhost",
      port: 4787,
      favorites,
      reviewers,
      agents: { claude: ["claude"], codex: ["codex"] },
    } as unknown as Config,
    backend,
    hub: { broadcast() { /* no clients */ } },
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };

  try {
    const now = Date.now();
    db.insertRepo(workRepo);
    db.insertRepo(homeRepo);
    db.insertEpic({ id: "e", jira_key: "E-100", title: "Epic", description: "", error: null, favorite_name: "WorkFav", repo_path: workDir, synced_ms: now, created_ms: now });

    // Prerequisite task E-101 with PR ready and branch feat/e1 in workDir.
    db.insertTask({
      id: "t-101", title: "E-101 Foundation", prompt: "Foundation", kind: "code", repo_path: workDir,
      target: "claude", target_state: "confirmed", agent: null, model: null, reasoning: null, review: null,
      base_branch: null, branch: "feat/e1", worktree_path: null, assignee: null, jira_key: "E-101",
      jira_url: "https://jira.example/browse/E-101", jira_parent_key: "E-100", jira_status: "In Progress",
      pr_url: "https://github.com/org/repo/pull/1", pr_meta: null, status: "dispatched",
      terminal_address: "s0", exit_code: null, created_ms: now, updated_ms: now, epic_id: "e", epic_out: 0,
    });
    db.insertItem({
      id: "pr-101", kind: "pr", status: "open", title: "PR ready", summary: "", body: "", context: "",
      options: null, ready: 1, handling: 0, source_ref: null, task_id: "t-101", structured: 1,
      created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null,
    });

    // Unconfigured open ready task E-107 (no repo, no harness) can pick repo & favorite on launch.
    db.insertTask({
      id: "t-107", title: "E-107 Unconfigured open task", prompt: "Do 107", kind: "code", repo_path: "",
      target: "", target_state: "suggested", agent: null, model: null, reasoning: null, review: null,
      base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: "E-107",
      jira_url: "https://jira.example/browse/E-107", jira_parent_key: "E-100", jira_status: "To Do",
      pr_url: null, pr_meta: null, status: "open", terminal_address: null, exit_code: null,
      created_ms: now, updated_ms: now, epic_id: "e", epic_out: 0,
    });

    // Archived task for E-108 so E-108 ticket re-surfaces as uncreated & ready.
    db.insertTask({
      id: "t-108-old", title: "E-108 Old attempt", prompt: "Old", kind: "code", repo_path: workDir,
      target: "claude", target_state: "confirmed", agent: null, model: null, reasoning: null, review: null,
      base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: "E-108",
      jira_url: "https://jira.example/browse/E-108", jira_parent_key: "E-100", jira_status: "To Do",
      pr_url: null, pr_meta: null, status: "archived", terminal_address: null, exit_code: null,
      created_ms: now - 10_000, updated_ms: now - 10_000, epic_id: "e", epic_out: 0,
    });

    db.replaceEpicTickets("e", [
      { epic_id: "e", jira_key: "E-101", title: "E-101 Foundation", description: "Foundation", jira_url: "https://jira.example/browse/E-101", jira_status: "In Progress", jira_parent_key: "E-100", suggested_repo_path: workDir, updated_ms: now },
      { epic_id: "e", jira_key: "E-102", title: "E-102 Build API", description: "Implement API", jira_url: "https://jira.example/browse/E-102", jira_status: "To Do", jira_parent_key: "E-100", suggested_repo_path: "", updated_ms: now },
      { epic_id: "e", jira_key: "E-103", title: "E-103 Build UI", description: "Implement UI", jira_url: "https://jira.example/browse/E-103", jira_status: "To Do", jira_parent_key: "E-100", suggested_repo_path: "", updated_ms: now },
      { epic_id: "e", jira_key: "E-104", title: "E-104 Killed ticket", description: "Cancelled", jira_url: "https://jira.example/browse/E-104", jira_status: "Killed", jira_parent_key: "E-100", suggested_repo_path: workDir, updated_ms: now },
      { epic_id: "e", jira_key: "E-105", title: "E-105 Empty desc", description: "", jira_url: "https://jira.example/browse/E-105", jira_status: "To Do", jira_parent_key: "E-100", suggested_repo_path: "", updated_ms: now },
      { epic_id: "e", jira_key: "E-106", title: "E-106 Dispatch failure", description: "Fail dispatch", jira_url: "https://jira.example/browse/E-106", jira_status: "To Do", jira_parent_key: "E-100", suggested_repo_path: "", updated_ms: now },
      { epic_id: "e", jira_key: "E-108", title: "E-108 Retry after archive", description: "Retry", jira_url: "https://jira.example/browse/E-108", jira_status: "To Do", jira_parent_key: "E-100", suggested_repo_path: "", updated_ms: now },
    ]);
    db.replaceEpicLinks("e", [
      { task_key: "E-102", blocked_by_key: "E-101" },
      { task_key: "E-103", blocked_by_key: "E-102" },
    ]);

    // 1. Validation failures create zero tasks.
    const noRepo = await req("POST", "/api/epics/e/tickets/E-102/launch", {});
    assert.equal(noRepo.status, 400);
    assert.equal(db.getTaskByJiraKey("E-102"), null);

    const blocked = await req("POST", "/api/epics/e/tickets/E-103/launch", { repo_path: workDir });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error ?? "", /blocked/);
    assert.equal(db.getTaskByJiraKey("E-103"), null);

    const killed = await req("POST", "/api/epics/e/tickets/E-104/launch", { repo_path: workDir });
    assert.equal(killed.status, 409);
    assert.match(killed.body.error ?? "", /killed/);

    const badFav = await req("POST", "/api/epics/e/tickets/E-102/launch", { repo_path: workDir, favorite: "HomeFav" });
    assert.equal(badFav.status, 400);
    assert.equal(db.getTaskByJiraKey("E-102"), null);

    const alreadyActive = await req("POST", "/api/epics/e/tickets/E-101/launch", { repo_path: workDir });
    assert.equal(alreadyActive.status, 409);

    // 2. Launching ready ticket E-102 with repo_path creates task, stacks on feat/e1, inherits WorkFav, and dispatches.
    const launch102 = await req("POST", "/api/epics/e/tickets/E-102/launch", { repo_path: workDir });
    assert.equal(launch102.status, 200, JSON.stringify(launch102.body));
    assert.equal(launch102.body.task.jira_key, "E-102");
    assert.equal(launch102.body.task.status, "dispatched");
    assert.equal(launch102.body.task.base_branch, "feat/e1");
    assert.equal(launch102.body.task.target, "claude");
    assert.equal(launch102.body.task.agent, "worker");
    assert.equal(launch102.body.task.model, "opus");
    assert.equal(started[0].git?.base, execFileSync("git", ["-C", workDir, "rev-parse", "feat/e1"]).toString().trim());

    // Board now shows E-102 as running with has_task: true.
    const detail = await req("GET", "/api/epics/e");
    const v102 = detail.body.views.find((v: any) => v.task.jira_key === "E-102");
    assert.equal(v102.has_task, true);
    assert.equal(v102.state, "running");

    // 3. Launching ready ticket E-105 with empty description falls back to title and accepts personal repo + explicit favorite.
    const launch105 = await req("POST", "/api/epics/e/tickets/E-105/launch", { repo_path: homeDir, favorite: "HomeFav" });
    assert.equal(launch105.status, 200, JSON.stringify(launch105.body));
    assert.equal(launch105.body.task.prompt, "E-105 Empty desc");
    assert.equal(launch105.body.task.target, "codex");
    assert.equal(launch105.body.task.model, "gpt-5");

    // 4. Launching an archived ticket E-108 creates a fresh active task and dispatches it with explicit target.
    const launch108 = await req("POST", "/api/epics/e/tickets/E-108/launch", { repo_path: homeDir, target: "claude" });
    assert.equal(launch108.status, 200, JSON.stringify(launch108.body));
    assert.notEqual(launch108.body.task.id, "t-108-old");
    assert.equal(launch108.body.task.status, "dispatched");

    // 5. Launching an unconfigured existing ready task E-107 with { repo_path, favorite } updates repo & conf and dispatches.
    const launch107 = await req("POST", "/api/epics/e/tasks/t-107/launch", { repo_path: homeDir, favorite: "HomeFav" });
    assert.equal(launch107.status, 200, JSON.stringify(launch107.body));
    const stored107 = db.getTask("t-107")!;
    assert.equal(stored107.repo_path, homeDir);
    assert.equal(stored107.target, "codex");
    assert.equal(stored107.status, "dispatched");

    // 6. Dispatch failure after creation returns 500 with { error, task } and leaves task open for retry.
    failNextStart = true;
    const failed106 = await req("POST", "/api/epics/e/tickets/E-106/launch", { repo_path: workDir });
    assert.equal(failed106.status, 500);
    assert.equal(failed106.body.task.jira_key, "E-106");
    assert.equal(failed106.body.task.status, "open");
    assert.match(failed106.body.error ?? "", /omnigent unavailable/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
