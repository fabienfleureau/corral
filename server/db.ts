// SQLite storage. One file at <dataDir>/corral.db.

import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { Item, ItemKind, ItemStatus, MetricEvent, Repo, Task, TaskStatus, TrackedTerminal } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  repo_path TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  target_state TEXT NOT NULL DEFAULT 'suggested',
  base_branch TEXT,
  branch TEXT,
  worktree_path TEXT,
  assignee TEXT,
  jira_key TEXT,
  jira_url TEXT,
  jira_parent_key TEXT,
  jira_status TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  terminal_address TEXT,
  exit_code INTEGER,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_jira_parent ON tasks(jira_parent_key);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  options TEXT,
  ready INTEGER NOT NULL DEFAULT 1,
  source_ref TEXT,
  task_id TEXT,
  structured INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  resolved_ms INTEGER,
  snooze_until_ms INTEGER,
  elicitation TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_task ON items(task_id);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_ref);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  jira_prefix TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS terminals (
  address TEXT PRIMARY KEY,
  task_id TEXT,
  name TEXT,
  agent TEXT,
  last_status TEXT,
  last_turn INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  ref TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics_events(name, ts);
`;

export class Db {
  raw: DatabaseSync;
  /** Compiled statements, keyed by SQL. Preparing re-compiles the SQL on every
   *  call, and the list endpoints run the same handful of queries on each page
   *  load and SSE-driven refresh. Dynamic WHERE/SET clauses produce a small,
   *  bounded set of distinct statements, so the cache is capped rather than
   *  keyed per shape. */
  private readonly statements = new Map<string, StatementSync>();
  private static readonly MAX_STATEMENTS = 256;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.raw.prepare(sql);
    if (this.statements.size >= Db.MAX_STATEMENTS) this.statements.clear();
    this.statements.set(sql, prepared);
    return prepared;
  }

  /** Migrate databases created by older versions. */
  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS benchmark_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), fetched_ms INTEGER NOT NULL, results TEXT NOT NULL)");
    this.raw.exec("CREATE TABLE IF NOT EXISTS benchmark_manual (model TEXT NOT NULL, benchmark TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY (model, benchmark))");
    // Ideas were removed; discard the legacy data and index.
    this.raw.exec("DROP TABLE IF EXISTS ideas");
    const cols = this.raw.prepare("PRAGMA table_info(items)").all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("context")) this.raw.exec(`ALTER TABLE items ADD COLUMN context TEXT NOT NULL DEFAULT ''`);
    if (!names.has("options")) this.raw.exec(`ALTER TABLE items ADD COLUMN options TEXT`);
    if (!names.has("ready")) this.raw.exec(`ALTER TABLE items ADD COLUMN ready INTEGER NOT NULL DEFAULT 1`);
    if (!names.has("elicitation")) this.raw.exec(`ALTER TABLE items ADD COLUMN elicitation TEXT`);
    const taskCols = this.raw.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    const taskNames = new Set(taskCols.map((c) => c.name));
    if (!taskNames.has("pr_url")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
    if (!taskNames.has("pr_meta")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN pr_meta TEXT`);
    if (!taskNames.has("model")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN model TEXT`);
    if (!taskNames.has("reasoning")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN reasoning TEXT`);
    if (!taskNames.has("agent")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN agent TEXT`);
    if (!taskNames.has("handoff")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN handoff TEXT`);
    if (!taskNames.has("kind")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'`);
    if (!taskNames.has("review")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN review TEXT`);
    if (!taskNames.has("jira_status")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN jira_status TEXT`);
    const repoCols = this.raw.prepare("PRAGMA table_info(repos)").all() as { name: string }[];
    if (!repoCols.some((c) => c.name === "context")) this.raw.exec(`ALTER TABLE repos ADD COLUMN context TEXT`);
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }

  // ---- tasks ----

  insertTask(t: Task): void {
    this.raw
      .prepare(
        `INSERT INTO tasks (id, title, prompt, repo_path, target, target_state, base_branch, branch,
          worktree_path, assignee, jira_key, jira_url, jira_parent_key, jira_status, pr_url, pr_meta, handoff, status, terminal_address,
          exit_code, created_ms, updated_ms, model, reasoning, agent, kind, review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.title, t.prompt, t.repo_path, t.target, t.target_state, t.base_branch, t.branch,
        t.worktree_path, t.assignee, t.jira_key, t.jira_url, t.jira_parent_key, t.jira_status ?? null, t.pr_url, t.pr_meta ?? null,
        t.handoff ?? null, t.status, t.terminal_address, t.exit_code, t.created_ms, t.updated_ms, t.model ?? null, t.reasoning ?? null, t.agent ?? null,
        t.kind ?? "code", t.review ?? null,
      );
  }

  updateTask(id: string, patch: Partial<Task>): void {
    const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof Task)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as never);
    this.stmt(`UPDATE tasks SET ${sets}, updated_ms = ? WHERE id = ?`).run(...values, Date.now(), id);
  }

  getTask(id: string): Task | null {
    const row = this.stmt(`SELECT * FROM tasks WHERE id = ?`).get(id);
    return (row as unknown as Task) ?? null;
  }

  getTaskByJiraKey(key: string): Task | null {
    const row = this.stmt(`SELECT * FROM tasks WHERE jira_key = ?`).get(key);
    return (row as unknown as Task) ?? null;
  }

  listTasks(status?: TaskStatus): Task[] {
    const rows = status
      ? this.stmt(`SELECT * FROM tasks WHERE status = ? ORDER BY created_ms DESC`).all(status)
      : this.stmt(`SELECT * FROM tasks ORDER BY created_ms DESC`).all();
    return rows as unknown as Task[];
  }

  // ---- items ----

  insertItem(i: Item): void {
    this.raw
      .prepare(
        `INSERT INTO items (id, kind, status, title, summary, body, context, options, ready, source_ref, task_id, structured,
          created_ms, updated_ms, resolved_ms, snooze_until_ms, elicitation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.id, i.kind, i.status, i.title, i.summary, i.body, i.context, i.options, i.ready, i.source_ref, i.task_id, i.structured,
        i.created_ms, i.updated_ms, i.resolved_ms, i.snooze_until_ms, i.elicitation ?? null,
      );
  }

  updateItem(id: string, patch: Partial<Item>): void {
    const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof Item)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as never);
    this.stmt(`UPDATE items SET ${sets}, updated_ms = ? WHERE id = ?`).run(...values, Date.now(), id);
  }

  getItem(id: string): Item | null {
    const row = this.stmt(`SELECT * FROM items WHERE id = ?`).get(id);
    return (row as unknown as Item) ?? null;
  }

  listItems(opts: { status?: ItemStatus; kind?: ItemKind } = {}): Item[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    const sql = `SELECT * FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_ms DESC`;
    return this.stmt(sql).all(...args) as unknown as Item[];
  }

  openQuestionItemForTerminal(address: string): Item | null {
    const row = this.raw
      .prepare(`SELECT * FROM items WHERE source_ref = ? AND kind = 'question' AND status = 'open' ORDER BY created_ms DESC LIMIT 1`)
      .get(address);
    return (row as unknown as Item) ?? null;
  }

  questionItemForTerminal(address: string): Item | null {
    const row = this.stmt(`SELECT * FROM items WHERE source_ref = ? AND kind = 'question' AND status IN ('open', 'resolved') ORDER BY created_ms DESC LIMIT 1`).get(address);
    return (row as unknown as Item) ?? null;
  }

  // ---- repos ----

  insertRepo(r: Repo): void {
    this.raw
      .prepare(`INSERT OR IGNORE INTO repos (id, name, path, jira_prefix, context, source, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.name, r.path, r.jira_prefix, r.context ?? null, r.source, r.created_ms);
  }

  updateRepo(id: string, patch: Partial<Repo>): void {
    const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof Repo)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as never);
    this.stmt(`UPDATE repos SET ${sets} WHERE id = ?`).run(...values, id);
  }

  deleteRepo(id: string): void {
    this.stmt(`DELETE FROM repos WHERE id = ?`).run(id);
  }

  getRepo(id: string): Repo | null {
    const row = this.stmt(`SELECT * FROM repos WHERE id = ?`).get(id);
    return (row as unknown as Repo) ?? null;
  }

  getRepoByPath(path: string): Repo | null {
    const row = this.stmt(`SELECT * FROM repos WHERE path = ?`).get(path);
    return (row as unknown as Repo) ?? null;
  }

  getRepoByJiraPrefix(prefix: string): Repo | null {
    const row = this.raw
      .prepare(`SELECT * FROM repos WHERE UPPER(jira_prefix) = ? ORDER BY created_ms LIMIT 1`)
      .get(prefix.toUpperCase());
    return (row as unknown as Repo) ?? null;
  }

  listRepos(): Repo[] {
    return this.stmt(`SELECT * FROM repos ORDER BY name`).all() as unknown as Repo[];
  }

  // ---- terminals ----

  upsertTerminal(t: TrackedTerminal): void {
    this.raw
      .prepare(
        `INSERT INTO terminals (address, task_id, name, agent, last_status, last_turn, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           task_id = COALESCE(excluded.task_id, terminals.task_id),
           name = COALESCE(excluded.name, terminals.name),
           agent = COALESCE(excluded.agent, terminals.agent),
           last_status = COALESCE(excluded.last_status, terminals.last_status),
           last_turn = excluded.last_turn,
           updated_ms = excluded.updated_ms`,
      )
      .run(t.address, t.task_id, t.name, t.agent, t.last_status, t.last_turn, t.updated_ms);
  }

  getTerminal(address: string): TrackedTerminal | null {
    const row = this.stmt(`SELECT * FROM terminals WHERE address = ?`).get(address);
    return (row as unknown as TrackedTerminal) ?? null;
  }

  listTerminals(): TrackedTerminal[] {
    return this.stmt(`SELECT * FROM terminals ORDER BY updated_ms DESC`).all() as unknown as TrackedTerminal[];
  }

  // ---- metrics ----

  recordMetric(name: string, ref: string | null, data: unknown): void {
    this.raw
      .prepare(`INSERT INTO metrics_events (ts, name, ref, data) VALUES (?, ?, ?, ?)`)
      .run(Date.now(), name, ref, data === undefined || data === null ? null : JSON.stringify(data));
  }

  metricSummary(): { name: string; count: number; last_ms: number }[] {
    return this.raw
      .prepare(`SELECT name, COUNT(*) AS count, MAX(ts) AS last_ms FROM metrics_events GROUP BY name ORDER BY count DESC`)
      .all() as unknown as { name: string; count: number; last_ms: number }[];
  }

  recentMetrics(limit = 50): MetricEvent[] {
    return this.raw
      .prepare(`SELECT * FROM metrics_events ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as MetricEvent[];
  }
}
