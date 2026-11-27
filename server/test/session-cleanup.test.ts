// Scheduled analysis and cleanup of orphaned omnigent sessions, plus preventive
// leak fixes in KPI, Epic Agent, OmnigentBackend.start, and PR respawn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { CaptureEngine } from "../capture.ts";
import { OmnigentBackend } from "../omnigent.ts";
import { KpiMonitor } from "../kpi.ts";
import { EpicAgentRunner } from "../epic-agent.ts";
import { syncTaskPr, type PrInfo } from "../pr.ts";
import { SessionCleanupRunner } from "../session-cleanup.ts";
import type { WorkerBackend, WorkerRunOutcome, WorkerSession } from "../worker.ts";
import type { Config } from "../config.ts";
import type { Epic, Item, Task } from "../types.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1",
    title: "Test task",
    prompt: "Test prompt",
    repo_path: "/tmp/repo",
    target: "claude",
    target_state: "confirmed",
    base_branch: null,
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: null,
    pr_meta: null,
    status: "done",
    terminal_address: "s1",
    exit_code: 0,
    handoff: null,
    created_ms: now - 3_600_000,
    updated_ms: now - 3_600_000,
    ...over,
  };
}

function makeSession(over: Partial<WorkerSession> = {}): WorkerSession {
  return {
    address: "s1",
    task_id: "task-1",
    name: "corral-test",
    harness: "claude",
    status: "done",
    blocked_kind: null,
    state: "live",
    turn: 1,
    cwd: "/tmp/repo",
    created_ms: Date.now() - 3_600_000,
    exit_code: 0,
    parent: null,
    ...over,
  };
}

function makeFakeBackend(sessions: WorkerSession[], opts: { lastOutcome?: WorkerRunOutcome | null; failAddresses?: Set<string> } = {}) {
  const archived: string[] = [];
  const killed: string[] = [];
  const cleaned: string[] = [];
  const backend: WorkerBackend = {
    name: "fake",
    start: async (start) => ({
      address: `new-${start.name ?? "session"}`,
      task_id: start.taskId,
      name: start.name,
      harness: start.harness,
      status: "working",
      blocked_kind: null,
      state: "live",
      turn: 0,
      cwd: start.repoPath,
      created_ms: Date.now(),
      exit_code: null,
      parent: null,
    }),
    list: async () => sessions,
    get: async (address) => sessions.find((s) => s.address === address) ?? null,
    lastRunOutcome: async () => opts.lastOutcome ?? null,
    read: async () => "",
    send: async () => undefined,
    resolveElicitation: async () => undefined,
    kill: async (address) => {
      if (opts.failAddresses?.has(address)) throw new Error("kill failed");
      killed.push(address);
    },
    archive: async (address) => {
      if (opts.failAddresses?.has(address)) throw new Error("archive failed");
      archived.push(address);
    },
    cleanup: async (address) => {
      if (opts.failAddresses?.has(address)) throw new Error("cleanup failed");
      cleaned.push(address);
    },
    history: async () => "",
    tree: async () => [],
    onEvent: () => ({ stop() {} }),
  };
  return { backend, archived, killed, cleaned };
}

test("SessionCleanupRunner diagnoses and cleans all orphan reasons while protecting external, active, and open-PR sessions", async () => {
  const db = new Db(":memory:");
  const now = Date.UTC(2026, 10, 27, 14, 0, 0);
  try {
    // 1. Terminal task with worktree -> worktree_cleaned
    db.insertTask(makeTask({
      id: "t-wt",
      title: "Done with worktree",
      status: "done",
      worktree_path: "/tmp/wt-1",
      terminal_address: "s-wt",
    }));
    // 2. Terminal task without worktree -> archived
    db.insertTask(makeTask({
      id: "t-no-wt",
      title: "Done ops task",
      kind: "ops",
      status: "archived",
      worktree_path: null,
      terminal_address: "s-no-wt",
    }));
    // 3. Done task with open PR -> kept_active
    db.insertTask(makeTask({
      id: "t-pr",
      title: "Open PR task",
      status: "done",
      worktree_path: "/tmp/wt-pr",
      terminal_address: "s-pr",
    }));
    const prItem: Item = {
      id: "item-pr",
      kind: "pr",
      status: "open",
      title: "PR ready",
      summary: "",
      body: "https://github.com/org/repo/pull/1",
      context: "",
      options: null,
      ready: 1,
      handling: 0,
      source_ref: "s-pr",
      task_id: "t-pr",
      structured: 1,
      created_ms: now - 1000,
      updated_ms: now - 1000,
      resolved_ms: null,
      snooze_until_ms: null,
    };
    db.insertItem(prItem);

    // 4. Superseded task (current terminal_address is s-active) + reopened task
    db.insertTask(makeTask({
      id: "t-dispatched",
      title: "Active dispatched",
      status: "dispatched",
      terminal_address: "s-active",
      updated_ms: now - 60_000,
    }));
    db.insertTask(makeTask({
      id: "t-reopened",
      title: "Reopened task",
      status: "open",
      terminal_address: null,
    }));
    // 5. Stale dispatched task (idle >24h, no open inbox item) -> kept_active + warning
    db.insertTask(makeTask({
      id: "t-stale",
      title: "Stale dispatched",
      status: "dispatched",
      terminal_address: "s-stale",
      updated_ms: now - 30 * 3_600_000,
    }));

    // KPI table + Epic agents table
    new KpiMonitor(db, makeFakeBackend([]).backend, { favorites: () => [], repos: () => [] });
    db.stmt(`UPDATE kpi_monitors SET run_name = 'KPI: Active · 1', run_state = 'running', address = 's-kpi-active' WHERE id = 'kpi-1'`).run();
    db.stmt(`UPDATE kpi_monitors SET run_name = NULL, run_state = 'complete', address = 's-kpi-done' WHERE id = 'kpi-2'`).run();

    new EpicAgentRunner(db, makeFakeBackend([]).backend, { favorites: () => [], repos: () => [] });
    db.raw.prepare(
      `INSERT INTO epic_agents (epic_id, settings, run_name, run_state, address) VALUES (?, '{}', ?, ?, ?)`,
    ).run("epic-1", "Epic: E-1 · 1", "running", "s-epic-active");
    db.raw.prepare(
      `INSERT INTO epic_agents (epic_id, settings, run_name, run_state, address) VALUES (?, '{}', NULL, 'complete', ?)`,
    ).run("epic-2", "s-epic-done");

    const sessions: WorkerSession[] = [
      // External user session: no corral labels, not in DB -> MUST BE IGNORED
      makeSession({ address: "s-external", task_id: null, harness: null, name: "my-manual-claude", status: "idle" }),
      // Active dispatched + its active child -> KEPT
      makeSession({ address: "s-active", task_id: "t-dispatched", status: "working", created_ms: now - 60_000 }),
      makeSession({ address: "s-child-active", task_id: null, harness: null, name: "sub", parent: "s-active", status: "working" }),
      // Open PR task -> KEPT
      makeSession({ address: "s-pr", task_id: "t-pr", status: "done" }),
      // Stale dispatched -> KEPT + WARNING
      makeSession({ address: "s-stale", task_id: "t-stale", status: "idle", created_ms: now - 30 * 3_600_000 }),
      // Fresh unlinked Corral session within grace window -> KEPT
      makeSession({ address: "s-fresh-unlinked", task_id: null, harness: "claude", status: "working", created_ms: now - 2 * 60_000 }),
      // Active KPI & Epic -> KEPT
      makeSession({ address: "s-kpi-active", task_id: null, harness: "claude", name: "KPI: Active · 1", status: "working" }),
      makeSession({ address: "s-epic-active", task_id: null, harness: "claude", name: "Epic: E-1 · 1", status: "working" }),

      // Orphans:
      makeSession({ address: "s-wt", task_id: "t-wt", status: "done" }),
      makeSession({ address: "s-no-wt", task_id: "t-no-wt", status: "done" }),
      makeSession({ address: "s-superseded", task_id: "t-dispatched", status: "done" }),
      makeSession({ address: "s-reopened", task_id: "t-reopened", status: "working" }), // working -> killed
      makeSession({ address: "s-missing", task_id: "t-does-not-exist", status: "done" }),
      makeSession({ address: "s-kpi-done", task_id: null, harness: "claude", name: "KPI: Done · 2", status: "done" }),
      makeSession({ address: "s-epic-done", task_id: null, harness: "claude", name: "Epic: E-2 · 2", status: "done" }),
      makeSession({ address: "s-child-orphan", task_id: null, harness: null, name: "sub-orphan", parent: "s-wt", status: "idle" }),
      makeSession({ address: "s-old-unlinked", task_id: null, harness: "codex", status: "idle", created_ms: now - 30 * 60_000 }),
    ];

    const { backend, archived, killed, cleaned } = makeFakeBackend(sessions);
    const broadcasts: [string, unknown][] = [];
    const runner = new SessionCleanupRunner(db, backend, {
      hub: { broadcast: (type, data) => broadcasts.push([type, data]) },
      clock: () => now,
    });

    // Dry-run first: nothing mutated
    const dry = await runner.run({ dryRun: true, trigger: "manual" });
    assert.equal(dry.dry_run, true);
    assert.equal(dry.scanned, sessions.length);
    assert.equal(dry.external_ignored, 1);
    assert.equal(dry.kept_active, 7);
    assert.equal(dry.would_clean, 9);
    assert.equal(dry.cleaned, 0);
    assert.equal(dry.warnings, 1);
    assert.equal(archived.length, 0);
    assert.equal(killed.length, 0);
    assert.equal(cleaned.length, 0);

    // Live run: cleans the 9 orphans, keeps 7 active, ignores 1 external, flags 1 stale warning
    const live = await runner.run({ dryRun: false, trigger: "scheduled" });
    assert.equal(live.dry_run, false);
    assert.equal(live.cleaned, 9);
    assert.equal(live.failed, 0);
    assert.equal(live.warnings, 1);
    assert.equal(live.external_ignored, 1);
    assert.equal(live.kept_active, 7);

    assert.deepEqual(cleaned, ["s-wt"]);
    assert.deepEqual(killed, ["s-reopened"]);
    assert.deepEqual(archived.sort(), [
      "s-child-orphan",
      "s-epic-done",
      "s-kpi-done",
      "s-missing",
      "s-no-wt",
      "s-old-unlinked",
      "s-superseded",
    ]);
    assert.ok(!archived.includes("s-external"));
    assert.ok(!archived.includes("s-active"));
    assert.ok(!archived.includes("s-pr"));
    assert.ok(!archived.includes("s-stale"));
    assert.ok(broadcasts.some(([type]) => type === "session.updated"));
    assert.equal(db.listSessionCleanupRuns(20).length, 2);
    assert.ok(db.recentMetrics().some((m) => m.name === "session.cleanup_run"));
    assert.ok(db.recentMetrics().some((m) => m.name === "session.orphan_cleaned"));
  } finally {
    db.close();
  }
});

test("SessionCleanupRunner prunes history to 20 runs", async () => {
  const db = new Db(":memory:");
  try {
    const { backend } = makeFakeBackend([]);
    let t = 1_000_000;
    const runner = new SessionCleanupRunner(db, backend, { clock: () => (t += 1000) });
    for (let i = 0; i < 25; i++) {
      await runner.run({ dryRun: true, trigger: "scheduled" });
    }
    assert.equal(db.listSessionCleanupRuns(30).length, 20);
  } finally {
    db.close();
  }
});

test("HTTP GET/POST /api/sessions/cleanup endpoints work", async () => {
  const db = new Db(":memory:");
  db.insertTask(makeTask({ id: "t1", status: "done", terminal_address: "s1" }));
  const { backend, archived } = makeFakeBackend([makeSession({ address: "s1", task_id: "t1", status: "done" })]);
  const cfg = { port: 0, host: "127.0.0.1", token: "tok", agents: {}, omnigent: { baseUrl: "http://127.0.0.1:1", token: "", hostId: "", agents: {} }, jira: { baseUrl: "", email: "", token: "", jql: "" }, assistant: [], workspaceRoots: [], configDir: "/tmp", dataDir: "/tmp", worktreesDir: "/tmp", herdrSocket: "", usage: { prices: {} } } as unknown as Config;
  const hub = { clients: new Set(), broadcast: () => undefined } as unknown as AppState["hub"];
  const capture = new CaptureEngine(db, backend, hub, cfg);
  const server = createHttpServer({ db, cfg, backend, capture, jira: null as never, hub });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const headers = { Authorization: "Bearer tok", "Content-Type": "application/json" };
    const status0 = await fetch(`http://127.0.0.1:${port}/api/sessions/cleanup`, { headers }).then((r) => r.json()) as { lastRun: unknown };
    assert.equal(status0.lastRun, null);

    const dry = await fetch(`http://127.0.0.1:${port}/api/sessions/cleanup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dryRun: true }),
    }).then((r) => r.json()) as { would_clean: number; cleaned: number };
    assert.equal(dry.would_clean, 1);
    assert.equal(dry.cleaned, 0);

    const live = await fetch(`http://127.0.0.1:${port}/api/sessions/cleanup`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    }).then((r) => r.json()) as { cleaned: number };
    assert.equal(live.cleaned, 1);
    assert.deepEqual(archived, ["s1"]);
  } finally {
    server.close();
    db.close();
  }
});

test("KpiMonitor.collect archives finished KPI session", async () => {
  const db = new Db(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "corral-kpi-archive-"));
  try {
    const validReport = JSON.stringify({
      summary: "Cycle ok",
      measurement: null,
      dataNeeds: [],
      productQuestions: [],
      proposals: [],
      memory: "remember",
    });
    const session = makeSession({ address: "kpi-sess-1", task_id: null, name: "KPI: Speed · abc", status: "done" });
    const { backend, archived } = makeFakeBackend([session], {
      lastOutcome: { kind: "message", text: validReport },
    });
    const monitor = new KpiMonitor(db, backend, {
      favorites: () => [{ name: "fav", harness: "claude", agent: "", model: "", reasoning: "", context: "professional", review: "" }],
      repos: () => [],
    });
    monitor.configure("kpi-1", {
      name: "Speed",
      definition: "Test",
      unit: "",
      sources: "",
      repoPath: dir,
      favorite: "fav",
      intervalHours: 0,
      context: "",
      goal: null,
    });
    db.stmt(`UPDATE kpi_monitors SET run_name = 'KPI: Speed · abc', run_state = 'running', address = 'kpi-sess-1', started_ms = ? WHERE id = 'kpi-1'`)
      .run(Date.now() - 600_000);
    await monitor.tick();
    assert.deepEqual(archived, ["kpi-sess-1"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EpicAgentRunner.collect archives finished epic agent session", async () => {
  const db = new Db(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-archive-"));
  try {
    const epic: Epic = { id: "epic-1", jira_key: "EX-1", title: "Epic", description: "Desc", error: null, synced_ms: 0, created_ms: 0 };
    db.insertEpic(epic);
    const validReport = JSON.stringify({
      summary: "Epic ok",
      steps: [],
      actionsTaken: [],
      problems: [],
      specGaps: [],
      clarifications: [],
      e2e: { status: "passed", summary: "ok", commands: [], gaps: [] },
      nextSteps: [],
      memory: "memo",
    });
    const session = makeSession({ address: "epic-sess-1", task_id: null, name: "Epic: EX-1 · abc", status: "done" });
    const { backend, archived } = makeFakeBackend([session], {
      lastOutcome: { kind: "message", text: validReport },
    });
    const runner = new EpicAgentRunner(db, backend, {
      favorites: () => [{ name: "fav", harness: "claude", agent: "", model: "", reasoning: "", context: "professional", review: "" }],
      repos: () => [],
    });
    runner.configure("epic-1", { repoPath: dir, favorite: "fav", intervalHours: 0, context: "" });
    db.stmt(`UPDATE epic_agents SET run_name = 'Epic: EX-1 · abc', run_state = 'running', address = 'epic-sess-1', started_ms = ? WHERE epic_id = 'epic-1'`)
      .run(Date.now() - 600_000);
    await runner.tick();
    assert.deepEqual(archived, ["epic-sess-1"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OmnigentBackend.start cleans up session when prompt delivery fails", async () => {
  const calls: string[] = [];
  const srv = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === "GET" && req.url?.startsWith("/v1/agents")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "agent-1", name: "corral-claude", harness: "claude-native" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "sess-created-1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/sessions/sess-created-1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "sess-created-1", live_status: "idle", labels: { "corral.harness": "claude" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/sessions/sess-created-1/events") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end("boom");
      return;
    }
    if (req.method === "DELETE" && req.url?.startsWith("/v1/sessions/sess-created-1")) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as { port: number }).port;
  try {
    const backend = new OmnigentBackend({ baseUrl: `http://127.0.0.1:${port}`, token: "", hostId: "", agents: {} });
    await assert.rejects(
      () => backend.start({
        taskId: "t1",
        name: "t1",
        repoPath: "/tmp/repo",
        git: { branch: "b1", base: "main" },
        prompt: "hello",
        harness: "claude",
        model: null,
        reasoning: null,
      }),
      /session created \(sess-created-1\) but prompt delivery failed/,
    );
    assert.ok(calls.some((c) => c === "DELETE /v1/sessions/sess-created-1?delete_branch=true"));
  } finally {
    srv.close();
  }
});

test("respawnForPr archives the superseded session", async () => {
  const db = new Db(":memory:");
  try {
    const task = makeTask({
      id: "t-respawn",
      status: "done",
      branch: "feat/x",
      worktree_path: "/tmp/wt-x",
      terminal_address: "old-session",
      pr_url: "https://github.com/org/repo/pull/42",
    });
    db.insertTask(task);
    const { backend, archived } = makeFakeBackend([]);
    const cfg = { host: "127.0.0.1", port: 4787, token: "tok", configDir: "/tmp", dataDir: "/tmp", worktreesDir: "/tmp", agents: { claude: ["claude"] } } as unknown as Config;
    const hub = { clients: new Set(), broadcast: () => undefined } as unknown as AppState["hub"];
    const pr: PrInfo = {
      url: "https://github.com/org/repo/pull/42",
      number: 42,
      title: "Fix",
      description: "",
      additions: 1,
      deletions: 1,
      changed_files: 1,
      state: "OPEN",
      head_sha: "abc123",
      base_ref: "main",
      mergeable: "CONFLICTING",
      checks: { total: 1, failed: 0, pending: false },
      threads: [],
      review_decision: null,
    };
    await syncTaskPr(db, hub, task, {
      backend,
      cfg,
      finder: async () => pr,
      force: true,
    });
    assert.deepEqual(archived, ["old-session"]);
    assert.notEqual(db.getTask("t-respawn")?.terminal_address, "old-session");
  } finally {
    db.close();
  }
});
