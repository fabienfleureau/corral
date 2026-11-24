import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Item, Task } from "../types.ts";

const { Db } = await import("../db.ts");
const { createHttpServer } = await import("../api.ts");
const { archiveEpicLaunchItems } = await import("../epic-graph.ts");
const { CaptureEngine } = await import("../capture.ts");
const { KpiMonitor } = await import("../kpi.ts");
const { EpicAgentRunner } = await import("../epic-agent.ts");

function makeTask(id: string, over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id,
    title: `Task ${id}`,
    prompt: "Do work",
    kind: "code",
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
    jira_status: null,
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

function makeItem(id: string, over: Partial<Item> = {}): Item {
  const now = Date.now();
  return {
    id,
    kind: "question",
    status: "open",
    title: `Item ${id}`,
    summary: "",
    body: "body",
    context: "",
    options: null,
    ready: 1,
    handling: 0,
    source_ref: null,
    task_id: null,
    structured: 1,
    created_ms: now,
    updated_ms: now,
    resolved_ms: null,
    snooze_until_ms: null,
    ...over,
  };
}

test("hot SQL queries use indexes and avoid temp B-trees where indexed", () => {
  const db = new Db(":memory:");
  try {
    const planOf = (sql: string) =>
      (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(" | ");

    const cases: { name: string; sql: string; expectIndex: string; noTempBTree?: boolean }[] = [
      {
        name: "getTaskByJiraKey",
        sql: "SELECT * FROM tasks WHERE jira_key = ?",
        expectIndex: "USING INDEX idx_tasks_jira_key",
      },
      {
        name: "listEpicTasks",
        sql: "SELECT * FROM tasks WHERE epic_id = ? ORDER BY jira_key, created_ms",
        expectIndex: "USING INDEX idx_tasks_epic",
        noTempBTree: true,
      },
      {
        name: "listTasks()",
        sql: "SELECT * FROM tasks ORDER BY created_ms DESC",
        expectIndex: "USING INDEX idx_tasks_created",
        noTempBTree: true,
      },
      {
        name: "listTasks(status)",
        sql: "SELECT * FROM tasks WHERE status = ? ORDER BY created_ms DESC",
        expectIndex: "USING INDEX idx_tasks_status_created",
        noTempBTree: true,
      },
      {
        name: "listDailyActivity",
        sql: `SELECT e.*, t.title, t.prompt, r.name AS repo_name, r.path AS repo_path, t.jira_url, t.jira_key, t.pr_url, t.terminal_address
              FROM task_events e JOIN tasks t ON t.id = e.task_id JOIN repos r ON r.path = t.repo_path
              WHERE COALESCE(r.context, 'professional') = 'professional' AND e.ts >= ? AND e.ts < ?
              ORDER BY e.ts, e.id`,
        expectIndex: "USING INDEX idx_task_events_ts",
        noTempBTree: true,
      },
      {
        name: "getAmendmentByItem",
        sql: "SELECT * FROM epic_amendments WHERE item_id = ?",
        expectIndex: "USING INDEX idx_epic_amendments_item",
      },
      {
        name: "listItems(status)",
        sql: "SELECT * FROM items WHERE status = ? ORDER BY created_ms DESC",
        expectIndex: "USING INDEX idx_items_status_created",
        noTempBTree: true,
      },
      {
        name: "listItems(kind)",
        sql: "SELECT * FROM items WHERE kind = ? ORDER BY created_ms DESC",
        expectIndex: "USING INDEX idx_items_kind_status_created",
      },
      {
        name: "listItems(status, kind)",
        sql: "SELECT * FROM items WHERE status = ? AND kind = ? ORDER BY created_ms DESC",
        expectIndex: "USING INDEX idx_items_kind_status_created",
        noTempBTree: true,
      },
      {
        name: "findPrItemForTask",
        sql: "SELECT * FROM items WHERE task_id = ? AND kind = 'pr' AND status != 'archived' ORDER BY created_ms DESC LIMIT 1",
        expectIndex: "USING INDEX idx_items_task_kind_status_created",
      },
      {
        name: "hasOpenPrItem",
        sql: "SELECT 1 FROM items WHERE task_id = ? AND kind = 'pr' AND status = 'open' LIMIT 1",
        expectIndex: "USING COVERING INDEX idx_items_task_kind_status_created",
      },
      {
        name: "openQuestionItemForTerminal",
        sql: "SELECT * FROM items WHERE source_ref = ? AND kind = 'question' AND status = 'open' ORDER BY created_ms DESC LIMIT 1",
        expectIndex: "USING INDEX idx_items_source_kind_status_created",
        noTempBTree: true,
      },
      {
        name: "openQuestionItemForTask",
        sql: "SELECT * FROM items WHERE task_id = ? AND kind = 'question' AND status = 'open' ORDER BY created_ms DESC LIMIT 1",
        expectIndex: "USING INDEX idx_items_task_kind_status_created",
        noTempBTree: true,
      },
      {
        name: "metrics (name, ref)",
        sql: "SELECT 1 FROM metrics_events WHERE name = ? AND ref = ? LIMIT 1",
        expectIndex: "USING COVERING INDEX idx_metrics_name_ref_id",
      },
      {
        name: "metrics (name, id DESC)",
        sql: "SELECT id, data FROM metrics_events WHERE name = 'item.replied' AND id > ? ORDER BY id DESC LIMIT 50",
        expectIndex: "USING INDEX idx_metrics_name_id",
        noTempBTree: true,
      },
      {
        name: "metrics (ts >= ?)",
        sql: "SELECT ref, name, COUNT(*) AS count, MIN(ts) AS first_ms, MAX(ts) AS last_ms FROM metrics_events WHERE ts >= ? AND ref IS NOT NULL GROUP BY ref, name",
        expectIndex: "USING INDEX idx_metrics_name_ref_id",
        noTempBTree: true,
      },
      {
        name: "kpi_measurements history",
        sql: "SELECT value, from_day, to_day, sources FROM kpi_measurements WHERE kpi_id = ? ORDER BY to_day DESC, from_day DESC LIMIT ?",
        expectIndex: "USING INDEX idx_kpi_measurements_history",
        noTempBTree: true,
      },
    ];

    for (const c of cases) {
      const plan = planOf(c.sql);
      assert.ok(plan.includes(c.expectIndex), `${c.name}: expected "${c.expectIndex}", got "${plan}"`);
      assert.ok(!/^(SCAN (tasks|items|epic_amendments|metrics_events|kpi_measurements)(?! USING))/.test(plan), `${c.name}: unexpected full table scan "${plan}"`);
      if (c.noTempBTree) {
        assert.ok(!plan.includes("USE TEMP B-TREE"), `${c.name}: unexpected temp B-tree in "${plan}"`);
      }
    }
  } finally {
    db.close();
  }
});

test("legacy database migration creates all new indexes including on migrated columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-migrate-idx-"));
  const dbPath = join(dir, "legacy.db");
  try {
    // Minimal pre-migration schema without epic_id or any of the new indexes.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE kpi_monitors (id TEXT PRIMARY KEY, settings TEXT NOT NULL, run_name TEXT, run_state TEXT, address TEXT, started_ms INTEGER, finished_ms INTEGER, error TEXT, report TEXT, report_ms INTEGER, last_measurement TEXT);
      CREATE TABLE reward_events (kind TEXT NOT NULL, ref TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY (kind, ref));
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '', repo_path TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', target_state TEXT NOT NULL DEFAULT 'suggested', base_branch TEXT, branch TEXT, worktree_path TEXT, assignee TEXT, jira_key TEXT, jira_url TEXT, jira_parent_key TEXT, status TEXT NOT NULL DEFAULT 'open', terminal_address TEXT, exit_code INTEGER, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
      CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', options TEXT, ready INTEGER NOT NULL DEFAULT 1, source_ref TEXT, task_id TEXT, structured INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, resolved_ms INTEGER, snooze_until_ms INTEGER);
      CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, jira_prefix TEXT, source TEXT NOT NULL DEFAULT 'manual', created_ms INTEGER NOT NULL);
      CREATE TABLE terminals (address TEXT PRIMARY KEY, task_id TEXT, name TEXT, agent TEXT, last_status TEXT, last_turn INTEGER NOT NULL DEFAULT 0, updated_ms INTEGER NOT NULL);
      CREATE TABLE metrics_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, name TEXT NOT NULL, ref TEXT, data TEXT);
      CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
      CREATE TABLE epics (id TEXT PRIMARY KEY, jira_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', error TEXT, synced_ms INTEGER NOT NULL, created_ms INTEGER NOT NULL);
      CREATE TABLE epic_links (epic_id TEXT NOT NULL, task_key TEXT NOT NULL, blocked_by_key TEXT NOT NULL, PRIMARY KEY (epic_id, task_key, blocked_by_key));
      CREATE TABLE epic_tickets (epic_id TEXT NOT NULL, jira_key TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', jira_url TEXT NOT NULL DEFAULT '', jira_status TEXT, jira_parent_key TEXT, suggested_repo_path TEXT NOT NULL DEFAULT '', updated_ms INTEGER NOT NULL, PRIMARY KEY (epic_id, jira_key));
      CREATE TABLE epic_designs (epic_id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT 'human', created_ms INTEGER NOT NULL, PRIMARY KEY (epic_id, version));
      CREATE TABLE epic_amendments (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, task_id TEXT NOT NULL, design_version INTEGER NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', item_id TEXT, created_ms INTEGER NOT NULL);
      CREATE TABLE epic_agents (epic_id TEXT PRIMARY KEY, settings TEXT NOT NULL, run_name TEXT, run_state TEXT, address TEXT, started_ms INTEGER, finished_ms INTEGER, error TEXT, report TEXT, report_ms INTEGER);
    `);
    raw.close();

    const db = new Db(dbPath);
    try {
      const indexes = new Set(
        (db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
          .map((r) => r.name),
      );
      for (const expected of [
        "idx_tasks_jira_key",
        "idx_tasks_epic",
        "idx_tasks_status_created",
        "idx_tasks_created",
        "idx_tasks_updated",
        "idx_task_events_ts",
        "idx_items_created",
        "idx_items_status_created",
        "idx_items_kind_status_created",
        "idx_items_task_kind_status_created",
        "idx_items_source_kind_status_created",
        "idx_metrics_name_ref_id",
        "idx_metrics_name_id",
        "idx_metrics_ts",
        "idx_epic_amendments_item",
        "idx_kpi_measurements_history",
      ]) {
        assert.ok(indexes.has(expected), `missing index ${expected} after legacy migration`);
      }
      assert.deepEqual(db.listEpicTasks("e1"), []);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new Db helpers preserve exact behavior across edge cases", () => {
  const db = new Db(":memory:");
  try {
    assert.deepEqual(db.getTasksByIds([]), []);
    const ids: string[] = [];
    for (let i = 0; i < 450; i++) {
      const id = `t-${i}`;
      ids.push(id);
      db.insertTask(makeTask(id, { created_ms: 1000 + i }));
    }
    const fetched = db.getTasksByIds([...ids, "t-0", "t-1", "missing-id"]);
    assert.equal(fetched.length, 450, "getTasksByIds deduplicates and chunks >400 ids");

    // findPrItemForTask & hasOpenPrItem & listActivePrItems & listTaskIdsWithActivePrItem
    db.insertItem(makeItem("pr-arch", { kind: "pr", status: "archived", task_id: "t-0", created_ms: 5000 }));
    assert.equal(db.findPrItemForTask("t-0"), null);
    assert.equal(db.findPrItemForTask("t-0", { includeArchived: true })?.id, "pr-arch");
    assert.equal(db.hasOpenPrItem("t-0"), false);

    db.insertItem(makeItem("pr-res", { kind: "pr", status: "resolved", task_id: "t-0", created_ms: 4000 }));
    assert.equal(db.findPrItemForTask("t-0")?.id, "pr-res");
    assert.equal(db.findPrItemForTask("t-0", { includeArchived: true })?.id, "pr-res");
    assert.equal(db.hasOpenPrItem("t-0"), false);

    db.insertItem(makeItem("pr-open", { kind: "pr", status: "open", task_id: "t-1", created_ms: 4500 }));
    assert.equal(db.hasOpenPrItem("t-1"), true);
    assert.deepEqual(db.listActivePrItems().map((i) => i.id), ["pr-open", "pr-res"]);
    assert.deepEqual(new Set(db.listTaskIdsWithActivePrItem()), new Set(["t-0", "t-1"]));

    // listUnarchivedItemsForTask
    db.insertItem(makeItem("q-open", { kind: "question", status: "open", task_id: "t-0", created_ms: 4600 }));
    assert.deepEqual(db.listUnarchivedItemsForTask("t-0").map((i) => i.id), ["q-open", "pr-res"]);

    // hasOpenItemFor
    db.insertItem(makeItem("q-src", { kind: "question", status: "open", source_ref: "addr-1", task_id: null, created_ms: 4700 }));
    assert.equal(db.hasOpenItemFor("addr-1", "t-999"), true);
    assert.equal(db.hasOpenItemFor("addr-none", "t-0"), true);
    assert.equal(db.hasOpenItemFor("addr-none", "t-999"), false);

    // openQuestionItemsFor with both address & taskId (deduped, ordered)
    db.insertItem(makeItem("q-both", { kind: "question", status: "open", source_ref: "addr-1", task_id: "t-0", created_ms: 4800 }));
    assert.deepEqual(
      db.openQuestionItemsFor({ address: "addr-1", taskId: "t-0" }).map((i) => i.id),
      ["q-both", "q-src", "q-open"],
    );

    // listSnoozedOpenItemsFor
    db.insertItem(makeItem("snz-task", { kind: "question", status: "open", task_id: "t-2", source_ref: "addr-2", snooze_until_ms: 20_000, created_ms: 4900 }));
    db.insertItem(makeItem("snz-addr", { kind: "pr", status: "open", task_id: null, source_ref: "addr-2", snooze_until_ms: 20_000, created_ms: 4950 }));
    db.insertItem(makeItem("snz-expired", { kind: "question", status: "open", task_id: "t-2", source_ref: "addr-2", snooze_until_ms: 5_000, created_ms: 4990 }));
    assert.deepEqual(
      db.listSnoozedOpenItemsFor({ taskId: "t-2", address: "addr-2", now: 10_000 }).map((i) => i.id),
      ["snz-addr", "snz-task"],
    );

    // listPrCandidateTasks & listCleanupCandidateTasks
    db.insertTask(makeTask("cand-pr", { status: "dispatched", kind: "code", branch: "feat/a", repo_path: "/r", created_ms: 5000 }));
    db.insertTask(makeTask("cand-rev", { status: "done", kind: "review", branch: "feat/b", repo_path: "/r", created_ms: 5001 }));
    assert.deepEqual(db.listPrCandidateTasks().map((t) => t.id), ["cand-pr"]);

    db.insertTask(makeTask("clean-ok", { status: "done", worktree_path: "/wt/1", terminal_address: "s1", created_ms: 5002 }));
    db.insertTask(makeTask("clean-blocked", { status: "done", worktree_path: "/wt/2", terminal_address: "s2", created_ms: 5003 }));
    db.insertItem(makeItem("pr-block", { kind: "pr", status: "open", task_id: "clean-blocked" }));
    assert.deepEqual(db.listCleanupCandidateTasks().map((t) => t.id), ["clean-ok"]);

    // countDesigns
    db.insertEpic({ id: "e1", jira_key: "E-1", title: "Epic", description: "", error: null, synced_ms: 1, created_ms: 1 });
    assert.equal(db.countDesigns("e1"), 0);
    db.insertDesign({ epic_id: "e1", version: 1, body: "v1", reason: "", author: "jira", created_ms: 1 });
    db.insertDesign({ epic_id: "e1", version: 2, body: "v2", reason: "", author: "human", created_ms: 2 });
    assert.equal(db.countDesigns("e1"), 2);
  } finally {
    db.close();
  }
});

test("Db.updateTask skips pre-read for untracked patches and logs history for tracked patches", () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask("t1", { status: "open" }));
    let getCalls = 0;
    const origGetTask = db.getTask.bind(db);
    db.getTask = (id: string) => {
      getCalls++;
      return origGetTask(id);
    };

    db.updateTask("t1", { pr_meta: JSON.stringify({ pr: { state: "OPEN" } }) }, false);
    assert.equal(getCalls, 0, "untracked pr_meta patch skips getTask pre-read");

    db.updateTask("t1", { status: "dispatched", branch: "feat/x" });
    assert.equal(getCalls, 1, "tracked patch reads before-row once");
    const events = db.listTaskEvents("t1");
    assert.ok(events.some((e) => e.kind === "status" && e.message.includes("open → dispatched")));
    assert.ok(events.some((e) => e.kind === "updated" && e.message.includes("Branch: feat/x")));
  } finally {
    db.close();
  }
});

test("archiveEpicLaunchItems short-circuits without scanning epics when no open launch items exist", () => {
  const db = new Db(":memory:");
  try {
    db.insertEpic({ id: "e1", jira_key: "E-1", title: "Epic", description: "", error: null, synced_ms: 1, created_ms: 1 });
    db.insertTask(makeTask("t1", { epic_id: "e1", jira_key: "E-2" }));
    let epicReads = 0;
    const origListEpics = db.listEpics.bind(db);
    const origListEpicTasks = db.listEpicTasks.bind(db);
    db.listEpics = () => { epicReads++; return origListEpics(); };
    db.listEpicTasks = (id: string) => { epicReads++; return origListEpicTasks(id); };

    archiveEpicLaunchItems(db, { broadcast() {} });
    assert.equal(epicReads, 0);
  } finally {
    db.close();
  }
});

test("GET /api/epics query count is constant regardless of epic count and GET /api/sessions skips per-session terminal reads", async () => {
  const db = new Db(":memory:");
  let listEpicTasksCalls = 0;
  let getTerminalCalls = 0;
  const origListEpicTasks = db.listEpicTasks.bind(db);
  const origGetTerminal = db.getTerminal.bind(db);
  db.listEpicTasks = (id: string) => { listEpicTasksCalls++; return origListEpicTasks(id); };
  db.getTerminal = (addr: string) => { getTerminalCalls++; return origGetTerminal(addr); };

  for (let i = 0; i < 10; i++) {
    const epicId = `epic-${i}`;
    db.insertEpic({ id: epicId, jira_key: `E-${i}`, title: `Epic ${i}`, description: "", error: null, synced_ms: 1, created_ms: i });
    db.insertTask(makeTask(`et-${i}`, { epic_id: epicId, jira_key: `T-${i}` }));
    db.upsertTerminal({ address: `sess-${i}`, task_id: `et-${i}`, name: `s${i}`, agent: "claude", last_status: "working", last_turn: 1, updated_ms: 1 });
  }
  db.insertTask(makeTask("unrelated", { status: "open" }));

  const backend = {
    name: "fake",
    async list() {
      return Array.from({ length: 10 }, (_, i) => ({
        address: `sess-${i}`,
        name: `s${i}`,
        harness: "claude",
        task_id: null,
        status: "working" as const,
        state: "live" as const,
        turn: 1,
        cwd: "/tmp/repo",
        created_ms: 1,
      }));
    },
  };

  const server = createHttpServer({
    db,
    cfg: { token: "test", agents: {}, omnigent: {}, jira: {}, host: "127.0.0.1", port: 0 } as never,
    backend: backend as never,
    capture: {} as never,
    jira: { configured: false } as never,
    hub: { broadcast() {}, clients: new Set() },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const headers = { Authorization: "Bearer test" };

    let prepareCalls = 0;
    const origPrepare = db.raw.prepare.bind(db.raw);
    (db.raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      prepareCalls++;
      return origPrepare(sql);
    };

    const epicsRes1 = await fetch(`http://127.0.0.1:${port}/api/epics`, { headers });
    assert.equal(epicsRes1.status, 200);
    const epicsBody = (await epicsRes1.json()) as unknown[];
    assert.equal(epicsBody.length, 10);
    assert.equal(listEpicTasksCalls, 0, "GET /api/epics batches instead of calling listEpicTasks per epic");

    const afterFirstEpics = prepareCalls;
    const epicsRes2 = await fetch(`http://127.0.0.1:${port}/api/epics`, { headers });
    assert.equal(epicsRes2.status, 200);
    assert.equal(prepareCalls, afterFirstEpics, "repeated GET /api/epics compiles zero new statements");

    const sessionsRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers });
    assert.equal(sessionsRes.status, 200);
    const sessionsBody = (await sessionsRes.json()) as { task_id: string | null; task_title: string | null }[];
    assert.equal(sessionsBody.length, 10);
    assert.equal(sessionsBody[0].task_id, "et-0");
    assert.equal(getTerminalCalls, 0, "GET /api/sessions resolves terminals in one batch without getTerminal N+1");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test("write helpers, CaptureEngine, KpiMonitor, and EpicAgentRunner reuse compiled statements", () => {
  const db = new Db(":memory:");
  const fakeStart = async () => ({ address: "a", status: "working" } as never);
  const kpi = new KpiMonitor(db, { start: fakeStart, get: async () => null, list: async () => [] }, { favorites: () => [], repos: () => [] });
  const epicAgent = new EpicAgentRunner(db, { start: fakeStart, get: async () => null, list: async () => [] }, { favorites: () => [], repos: () => [] });
  const capture = new CaptureEngine(db, { list: async () => [], get: async () => null, start: fakeStart, send: async () => undefined, read: async () => "", resolveElicitation: async () => undefined, onEvent: () => ({ stop: () => undefined }), name: "fake" } as never, { broadcast() {} });

  let prepared = 0;
  const origPrepare = db.raw.prepare.bind(db.raw);
  (db.raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    prepared++;
    return origPrepare(sql);
  };

  try {
    for (let i = 0; i < 4; i++) {
      db.insertTask(makeTask(`w-${i}`));
      db.upsertTerminal({ address: `a-${i}`, task_id: `w-${i}`, name: "n", agent: "claude", last_status: "working", last_turn: 1, updated_ms: i });
      db.recordMetric("test.metric", `w-${i}`, { i });
      kpi.view("kpi-1");
      epicAgent.view("missing");
      capture.resetStoppedRetries(`a-${i}`);
    }
    const firstPassPrepared = prepared;
    assert.ok(firstPassPrepared > 0);

    for (let i = 4; i < 8; i++) {
      db.insertTask(makeTask(`w-${i}`));
      db.upsertTerminal({ address: `a-${i}`, task_id: `w-${i}`, name: "n", agent: "claude", last_status: "working", last_turn: 1, updated_ms: i });
      db.recordMetric("test.metric", `w-${i}`, { i });
      kpi.view("kpi-1");
      epicAgent.view("missing");
      capture.resetStoppedRetries(`a-${i}`);
    }
    assert.equal(prepared, firstPassPrepared, "second pass compiles zero new SQLite statements");
  } finally {
    capture.dispose();
    db.close();
  }
});
