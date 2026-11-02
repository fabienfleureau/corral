// SQLite storage. One file at <dataDir>/corral.db. Schema is additive only.

import { DatabaseSync } from "node:sqlite";
import type {
  Idea,
  Item,
  ItemKind,
  ItemStatus,
  MetricEvent,
  Task,
  TaskStatus,
  TrackedTerminal,
} from "./types.ts";

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
  source_ref TEXT,
  task_id TEXT,
  structured INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  resolved_ms INTEGER,
  snooze_until_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_task ON items(task_id);
CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_ref);

CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT 'workflow',
  origin TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'new',
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);

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

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec(SCHEMA);
  }

  close(): void {
    this.raw.close();
  }

  // ---- tasks ----

  insertTask(t: Task): void {
    this.raw
      .prepare(
        `INSERT INTO tasks (id, title, prompt, repo_path, target, target_state, base_branch, branch,
          worktree_path, assignee, jira_key, jira_url, jira_parent_key, status, terminal_address,
          exit_code, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.title, t.prompt, t.repo_path, t.target, t.target_state, t.base_branch, t.branch,
        t.worktree_path, t.assignee, t.jira_key, t.jira_url, t.jira_parent_key, t.status,
        t.terminal_address, t.exit_code, t.created_ms, t.updated_ms,
      );
  }

  updateTask(id: string, patch: Partial<Task>): void {
    const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof Task)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as never);
    this.raw.prepare(`UPDATE tasks SET ${sets}, updated_ms = ? WHERE id = ?`).run(...values, Date.now(), id);
  }

  getTask(id: string): Task | null {
    const row = this.raw.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
    return (row as unknown as Task) ?? null;
  }

  getTaskByJiraKey(key: string): Task | null {
    const row = this.raw.prepare(`SELECT * FROM tasks WHERE jira_key = ?`).get(key);
    return (row as unknown as Task) ?? null;
  }

  listTasks(status?: TaskStatus): Task[] {
    const rows = status
      ? this.raw.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY created_ms DESC`).all(status)
      : this.raw.prepare(`SELECT * FROM tasks ORDER BY created_ms DESC`).all();
    return rows as unknown as Task[];
  }

  // ---- items ----

  insertItem(i: Item): void {
    this.raw
      .prepare(
        `INSERT INTO items (id, kind, status, title, summary, body, source_ref, task_id, structured,
          created_ms, updated_ms, resolved_ms, snooze_until_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        i.id, i.kind, i.status, i.title, i.summary, i.body, i.source_ref, i.task_id, i.structured,
        i.created_ms, i.updated_ms, i.resolved_ms, i.snooze_until_ms,
      );
  }

  updateItem(id: string, patch: Partial<Item>): void {
    const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof Item)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as never);
    this.raw.prepare(`UPDATE items SET ${sets}, updated_ms = ? WHERE id = ?`).run(...values, Date.now(), id);
  }

  getItem(id: string): Item | null {
    const row = this.raw.prepare(`SELECT * FROM items WHERE id = ?`).get(id);
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
    return this.raw.prepare(sql).all(...args) as unknown as Item[];
  }

  openQuestionItemForTerminal(address: string): Item | null {
    const row = this.raw
      .prepare(`SELECT * FROM items WHERE source_ref = ? AND kind = 'question' AND status = 'open' ORDER BY created_ms DESC LIMIT 1`)
      .get(address);
    return (row as unknown as Item) ?? null;
  }

  // ---- ideas ----

  insertIdea(i: Idea): void {
    this.raw
      .prepare(`INSERT INTO ideas (id, text, tag, origin, status, created_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(i.id, i.text, i.tag, i.origin, i.status, i.created_ms);
  }

  updateIdea(id: string, patch: Partial<Idea>): void {
    const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof Idea)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as never);
    this.raw.prepare(`UPDATE ideas SET ${sets} WHERE id = ?`).run(...values, id);
  }

  listIdeas(status?: string): Idea[] {
    const rows = status
      ? this.raw.prepare(`SELECT * FROM ideas WHERE status = ? ORDER BY created_ms DESC`).all(status)
      : this.raw.prepare(`SELECT * FROM ideas ORDER BY created_ms DESC`).all();
    return rows as unknown as Idea[];
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
    const row = this.raw.prepare(`SELECT * FROM terminals WHERE address = ?`).get(address);
    return (row as unknown as TrackedTerminal) ?? null;
  }

  listTerminals(): TrackedTerminal[] {
    return this.raw.prepare(`SELECT * FROM terminals ORDER BY updated_ms DESC`).all() as unknown as TrackedTerminal[];
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
