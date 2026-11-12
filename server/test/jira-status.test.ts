// Jira status sync: a task imported from Jira mirrors its lifecycle onto the
// ticket — dispatch is "In Progress", an open PR/MR "Code Review", a PR past
// the readiness gate "Ready to merge", a merge "Done".

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { dispatchTask } from "../dispatch.ts";
import {
  JIRA_STAGE_ORDER,
  advanceJiraStatus,
  jiraStatusNames,
  normalizeStatus,
  stageOfStatus,
  syncJiraStage,
  type JiraTransitionGateway,
} from "../jira-status.ts";
import { syncTaskPr, type PrInfo } from "../pr.ts";
import type { Config } from "../config.ts";
import type { Task } from "../types.ts";
import type { WorkerBackend, WorkerSession, WorkerStart } from "../worker.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "ABC-1 Fix the thing", prompt: "Fix the thing", kind: "code", repo_path: "/tmp/repo",
    target: "codex", target_state: "suggested", base_branch: null, branch: null, worktree_path: null,
    assignee: null, jira_key: "ABC-1", jira_url: "https://jira.example/browse/ABC-1", jira_parent_key: null,
    pr_url: null, pr_meta: null, status: "open", terminal_address: null, exit_code: null,
    created_ms: now, updated_ms: now, ...over,
  };
}

/** A linear-ish workflow: transitions are only offered from the issue's
 *  current status, exactly like Jira's `/transitions` endpoint. */
type Step = { id: string; to: string };

function linearWorkflow(from = "To Do"): Record<string, Step[]> {
  const steps = [
    ["To Do", "11", "In Progress"],
    ["In Progress", "21", "Code Review"],
    ["Code Review", "31", "Ready to merge"],
    ["Ready to merge", "41", "Done"],
  ];
  const out: Record<string, Step[]> = {};
  for (const [status, id, to] of steps) out[status] = [{ id, to }];
  // A real workflow also allows sideways moves; keep one to prove the walker
  // does not take them.
  out["In Progress"].push({ id: "99", to: "Blocked" });
  return out;
}

function fakeJira(start = "To Do", workflow = linearWorkflow()) {
  const applied: string[] = [];
  let calls = 0;
  const state = { current: start };
  const gateway: JiraTransitionGateway = {
    configured: true,
    async transitions() {
      calls++;
      return (workflow[state.current] ?? []).map((s) => ({ id: s.id, name: s.id, to: { name: s.to } }));
    },
    async transition(_key: string, id: string) {
      const step = (workflow[state.current] ?? []).find((s) => s.id === id);
      assert.ok(step, `unknown transition ${id} from ${state.current}`);
      applied.push(step.to);
      state.current = step.to;
    },
  };
  return { gateway, applied, current: () => state.current, calls: () => calls };
}

function withDb(fn: (db: Db) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-jira-status-"));
    const db = new Db(join(dir, "test.db"));
    try {
      await fn(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const hub = { broadcast: () => undefined };

/** The syncs are deliberately fire-and-forget: wait for the fake workflow to
 *  reach a status instead of racing it. */
async function until(predicate: () => boolean, what: string, ms = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function synced(db: Db, taskId = "task-1") {
  return db.recentMetrics(50).filter((m) => m.name === "jira.status_synced" && m.ref === taskId);
}

test("status names: defaults, per-workflow overrides, disabled stages", () => {
  const defaults = jiraStatusNames();
  assert.deepEqual(JIRA_STAGE_ORDER.map((s) => defaults[s]), ["To Do", "In Progress", "Code Review", "Ready to merge", "Done"]);
  const custom = jiraStatusNames({ code_review: "  In Review ", done: "" });
  assert.equal(custom.code_review, "In Review");
  assert.equal(custom.done, "", "a blank name disables the stage");
  assert.equal(custom.in_progress, "In Progress", "untouched stages keep their default");
  // Matching ignores case, accents and extra spaces.
  assert.equal(normalizeStatus("  Ready  To  Merge "), "ready to merge");
  assert.equal(normalizeStatus("Résolu"), "resolu");
  assert.equal(stageOfStatus("ready TO merge", defaults), "ready_to_merge");
  assert.equal(stageOfStatus("Blocked", defaults), null);
  assert.equal(stageOfStatus(null, defaults), null);
});

test("advance: a directly available transition is used, unnoticed statuses are not", async () => {
  const jira = fakeJira("In Progress");
  const result = await advanceJiraStatus(jira.gateway, "ABC-1", "Code Review", {
    from: "In Progress",
    chain: JIRA_STAGE_ORDER.map((s) => jiraStatusNames()[s]),
  });
  assert.deepEqual(result.path, ["Code Review"]);
  assert.deepEqual(jira.applied, ["Code Review"]);
});

test("advance: missing stages are walked in workflow order", async () => {
  // Corral missed two stages (server was off): the walker must still land on Done.
  const jira = fakeJira("To Do");
  const result = await advanceJiraStatus(jira.gateway, "ABC-1", "Done", {
    from: "To Do",
    chain: JIRA_STAGE_ORDER.map((s) => jiraStatusNames()[s]),
  });
  assert.deepEqual(result.path, ["In Progress", "Code Review", "Ready to merge", "Done"]);
  assert.equal(jira.current(), "Done");
  assert.ok(!jira.applied.includes("Blocked"), "sideways transitions are never taken");
});

test("advance: an unreachable status fails with the available transitions", async () => {
  const workflow = linearWorkflow();
  workflow["In Progress"] = [{ id: "99", to: "Blocked" }];
  const jira = fakeJira("In Progress", workflow);
  await assert.rejects(
    advanceJiraStatus(jira.gateway, "ABC-1", "Code Review", { from: "In Progress", chain: ["In Progress", "Code Review"] }),
    /cannot reach "Code Review".*99=Blocked/,
  );
});

test("sync: only forwards, cached status is the dedupe", withDb(async (db) => {
  db.insertTask(makeTask({ jira_status: "Ready to merge" }));
  const jira = fakeJira("Ready to merge");
  const result = await syncJiraStage({ db, hub, gateway: jira.gateway }, db.getTask("task-1")!, "code_review");
  assert.equal(result.applied, false);
  assert.match(result.reason, /already at Ready to merge/);
  assert.equal(jira.calls(), 0, "no Jira call once the ticket is at that stage or beyond");
  assert.equal(db.getTask("task-1")?.jira_status, "Ready to merge");
}));

test("sync: applies the stage, caches the status and records a metric", withDb(async (db) => {
  db.insertTask(makeTask());
  const jira = fakeJira("To Do");
  const result = await syncJiraStage({ db, hub, gateway: jira.gateway }, db.getTask("task-1")!, "code_review");
  assert.equal(result.applied, true);
  assert.equal(result.status, "Code Review");
  assert.deepEqual(result.path, ["In Progress", "Code Review"]);
  assert.equal(db.getTask("task-1")?.jira_status, "Code Review");
  assert.equal(synced(db).length, 1);
}));

test("sync: concurrent stages for one ticket are applied in order", withDb(async (db) => {
  db.insertTask(makeTask());
  const jira = fakeJira("To Do");
  const task = db.getTask("task-1")!;
  const first = syncJiraStage({ db, hub, gateway: jira.gateway }, task, "code_review");
  const second = syncJiraStage({ db, hub, gateway: jira.gateway }, task, "ready_to_merge");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.applied, true);
  assert.equal(b.applied, true);
  assert.deepEqual(jira.applied, ["In Progress", "Code Review", "Ready to merge"]);
  assert.equal(db.getTask("task-1")?.jira_status, "Ready to merge");
}));

test("sync: no ticket, disabled stage and unconfigured Jira are no-ops", withDb(async (db) => {
  db.insertTask(makeTask({ id: "no-key", jira_key: null }));
  const jira = fakeJira("To Do");
  const noKey = await syncJiraStage({ db, hub, gateway: jira.gateway }, db.getTask("no-key")!, "in_progress");
  assert.equal(noKey.applied, false);
  assert.match(noKey.reason, /no jira ticket/);

  db.insertTask(makeTask({ id: "disabled" }));
  const disabled = await syncJiraStage(
    { db, hub, gateway: jira.gateway, statuses: { in_progress: "" } },
    db.getTask("disabled")!,
    "in_progress",
  );
  assert.equal(disabled.applied, false);
  assert.match(disabled.reason, /disabled/);

  db.insertTask(makeTask({ id: "offline" }));
  const offline = await syncJiraStage(
    { db, hub, gateway: { ...jira.gateway, configured: false } },
    db.getTask("offline")!,
    "in_progress",
  );
  assert.equal(offline.applied, false);
  assert.match(offline.reason, /not configured/);
  assert.equal(jira.calls(), 0);
}));

test("sync: a Jira failure is recorded, never thrown", withDb(async (db) => {
  db.insertTask(makeTask());
  const failing: JiraTransitionGateway = {
    configured: true,
    transitions: async () => [],
    transition: async () => undefined,
  };
  const result = await syncJiraStage({ db, hub, gateway: failing }, db.getTask("task-1")!, "done");
  assert.equal(result.applied, false);
  assert.match(result.reason, /cannot reach "Done"/);
  assert.equal(db.getTask("task-1")?.jira_status, null, "nothing was reached, so nothing is cached");
  assert.equal(db.recentMetrics(50).filter((m) => m.name === "jira.status_failed").length, 1);
}));

test("pr sync drives Code Review -> Ready to merge -> Done on the ticket", withDb(async (db) => {
  db.insertTask(makeTask({ branch: "feat/abc-1", repo_path: "/tmp/repo" }));
  const jira = fakeJira("To Do");
  const base: PrInfo = {
    url: "https://example.com/pr/7", title: "feat: x", state: "OPEN", number: 7, description: "x",
    additions: 1, deletions: 1, changed_files: 1, mergeable: "MERGEABLE", base_ref: "main",
    review_decision: null, checks: { total: 1, failed: 0, pending: false },
    threads: [{ id: "t1", author: "reviewer", body: "please fix" }],
  };
  let current: PrInfo = base;
  const opts = { finder: () => current, jira: jira.gateway };

  await syncTaskPr(db, hub, db.getTask("task-1")!, opts);
  await until(() => jira.current() === "Code Review", "code review");

  current = { ...base, threads: [] };
  await syncTaskPr(db, hub, db.getTask("task-1")!, opts);
  await until(() => jira.current() === "Ready to merge", "ready to merge");

  current = { ...base, threads: [], state: "MERGED" };
  await syncTaskPr(db, hub, db.getTask("task-1")!, opts);
  await until(() => jira.current() === "Done", "done");
  assert.deepEqual(jira.applied, ["In Progress", "Code Review", "Ready to merge", "Done"]);
  assert.equal(db.getTask("task-1")?.status, "done");
}));

test("pr sync: a merged PR still completes the task without a Jira ticket", withDb(async (db) => {
  db.insertTask(makeTask({ jira_key: null, branch: "feat/x", repo_path: "/tmp/repo" }));
  const jira = fakeJira("To Do");
  const pr: PrInfo = {
    url: "https://example.com/pr/8", title: "feat: y", state: "MERGED", number: 8, description: "",
    additions: 1, deletions: 0, changed_files: 1, mergeable: "MERGEABLE", base_ref: "main",
    review_decision: null, checks: { total: 0, failed: 0, pending: false }, threads: [],
  };
  await syncTaskPr(db, hub, db.getTask("task-1")!, { finder: () => pr, jira: jira.gateway });
  assert.equal(db.getTask("task-1")?.status, "done");
  assert.equal(jira.calls(), 0, "a task without a ticket never calls Jira");
}));

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

test("dispatch moves the ticket to In Progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-jira-dispatch-"));
  const db = new Db(join(dir, "test.db"));
  try {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    const task = makeTask({ repo_path: dir });
    db.insertTask(task);
    const { backend } = fakeBackend();
    const jira = fakeJira("To Do");
    const cfg = { configDir: dir, host: "localhost", port: 4787, token: "" } as Config;
    await dispatchTask(db, cfg, backend, task, "codex", { useWorktree: false, jira: jira.gateway });
    await until(() => jira.current() === "In Progress", "in progress");
    assert.equal(db.getTask(task.id)?.jira_status, "In Progress");
    assert.match(jira.applied.join(","), /^In Progress$/, "review/PR stages are left to the PR sync");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
