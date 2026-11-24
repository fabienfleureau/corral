// SQLite storage. One file at <dataDir>/corral.db.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { DailyActivity, Epic, EpicAmendment, EpicDesign, EpicLink, EpicTicket, Item, ItemKind, ItemStatus, MetricEvent, PlanReview, PlanReviewComment, PlanRevision, PlanSubtask, Repo, Task, TaskAttachment, TaskStatus, TrackedTerminal } from "./types.ts";
import { logTaskChanges, TRACKED_TASK_FIELDS, type TaskEvent } from "./task-events.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kpi_monitors (
  id TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  run_name TEXT,
  run_state TEXT,
  address TEXT,
  started_ms INTEGER,
  finished_ms INTEGER,
  error TEXT,
  report TEXT,
  report_ms INTEGER,
  last_measurement TEXT
);
CREATE TABLE IF NOT EXISTS reward_events (
  kind TEXT NOT NULL, ref TEXT NOT NULL, created_ms INTEGER NOT NULL,
  PRIMARY KEY (kind, ref)
);

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
  handling INTEGER NOT NULL DEFAULT 0,
  source_ref TEXT,
  task_id TEXT,
  structured INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  resolved_ms INTEGER,
  snooze_until_ms INTEGER,
  elicitation TEXT,
  triage TEXT,
  snooze_count INTEGER NOT NULL DEFAULT 0
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

-- Task history: what happened to one task, in order (see task-events.ts).
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, ts);

-- Epics: a Jira epic and its ordered tasks (see epic.ts). Jira owns the
-- structure; links are "task_key is blocked by blocked_by_key".
CREATE TABLE IF NOT EXISTS epics (
  id TEXT PRIMARY KEY,
  jira_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  error TEXT,
  synced_ms INTEGER NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS epic_links (
  epic_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  blocked_by_key TEXT NOT NULL,
  PRIMARY KEY (epic_id, task_key, blocked_by_key)
);
CREATE TABLE IF NOT EXISTS epic_tickets (
  epic_id TEXT NOT NULL,
  jira_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  jira_url TEXT NOT NULL DEFAULT '',
  jira_status TEXT,
  jira_parent_key TEXT,
  suggested_repo_path TEXT NOT NULL DEFAULT '',
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (epic_id, jira_key)
);

CREATE TABLE IF NOT EXISTS epic_designs (
  epic_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'human',
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (epic_id, version)
);
CREATE TABLE IF NOT EXISTS epic_amendments (
  id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  design_version INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  item_id TEXT,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_epic_amendments_epic ON epic_amendments(epic_id, status);
CREATE TABLE IF NOT EXISTS epic_agents (
  epic_id TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  run_name TEXT,
  run_state TEXT,
  address TEXT,
  started_ms INTEGER,
  finished_ms INTEGER,
  error TEXT,
  report TEXT,
  report_ms INTEGER
);

-- Files dropped on a task's prompt. The bytes wait here until dispatch hands
-- them to the worker backend (see attachments.ts).
CREATE TABLE IF NOT EXISTS task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id, created_ms);

CREATE TABLE IF NOT EXISTS plan_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  contract TEXT NOT NULL,
  subtasks_json TEXT NOT NULL,
  markdown TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  UNIQUE(task_id, version)
);
CREATE INDEX IF NOT EXISTS idx_plan_revisions_task ON plan_revisions(task_id, version);

CREATE TABLE IF NOT EXISTS plan_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  note TEXT NOT NULL,
  comments_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_reviews_task ON plan_reviews(task_id, created_ms);
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
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.raw.exec("PRAGMA temp_store = MEMORY;");
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  reward(kind: "task" | "inbox", ref: string): void {
    this.stmt("INSERT OR IGNORE INTO reward_events (kind, ref, created_ms) VALUES (?, ?, ?)").run(kind, ref, Date.now());
  }

  progression(): { xp: number; level: number; levelXp: number; nextLevelXp: number; tasks: number; inbox: number } {
    const counts = this.stmt("SELECT kind, COUNT(*) AS count FROM reward_events GROUP BY kind").all() as { kind: string; count: number }[];
    const tasks = counts.find((r) => r.kind === "task")?.count ?? 0;
    const inbox = counts.find((r) => r.kind === "inbox")?.count ?? 0;
    const xp = tasks * 10 + inbox * 20;
    let level = 1, levelXp = xp;
    while (levelXp >= level * 100) { levelXp -= level * 100; level++; }
    return { xp, level, levelXp, nextLevelXp: level * 100, tasks, inbox };
  }

  stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.raw.prepare(sql);
    if (this.statements.size >= Db.MAX_STATEMENTS) this.statements.clear();
    this.statements.set(sql, prepared);
    return prepared;
  }

  /** Migrate databases created by older versions. */
  private migrate(): void {
    // Last Pull Requests page listing: the page shows it instead of nothing while
    // the first platform refresh runs after a restart.
    this.raw.exec("CREATE TABLE IF NOT EXISTS pull_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), fetched_ms INTEGER NOT NULL, pulls TEXT NOT NULL)");
    // Ideas were removed; discard the legacy data and index.
    this.raw.exec("DROP TABLE IF EXISTS ideas");
    // KPI goals: one row per sourced measurement window, and the goal's baseline.
    this.raw.exec(`CREATE TABLE IF NOT EXISTS kpi_measurements (
      kpi_id TEXT NOT NULL, from_day TEXT NOT NULL, to_day TEXT NOT NULL,
      value REAL NOT NULL, sources TEXT NOT NULL, recorded_ms INTEGER NOT NULL,
      PRIMARY KEY (kpi_id, from_day, to_day)
    )`);
    // Start the history from the last measurement kept before it existed.
    this.raw.exec(`INSERT OR IGNORE INTO kpi_measurements (kpi_id, from_day, to_day, value, sources, recorded_ms)
      SELECT id, json_extract(last_measurement, '$.from'), json_extract(last_measurement, '$.to'), json_extract(last_measurement, '$.value'),
        json_extract(last_measurement, '$.sources'), COALESCE(report_ms, 0)
      FROM kpi_monitors WHERE last_measurement IS NOT NULL`);
    const kpiCols = new Set((this.raw.prepare("PRAGMA table_info(kpi_monitors)").all() as { name: string }[]).map((c) => c.name));
    if (!kpiCols.has("goal_baseline")) this.raw.exec("ALTER TABLE kpi_monitors ADD COLUMN goal_baseline TEXT");
    const cols = this.raw.prepare("PRAGMA table_info(items)").all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("context")) this.raw.exec(`ALTER TABLE items ADD COLUMN context TEXT NOT NULL DEFAULT ''`);
    if (!names.has("options")) this.raw.exec(`ALTER TABLE items ADD COLUMN options TEXT`);
    if (!names.has("ready")) this.raw.exec(`ALTER TABLE items ADD COLUMN ready INTEGER NOT NULL DEFAULT 1`);
    if (!names.has("elicitation")) this.raw.exec(`ALTER TABLE items ADD COLUMN elicitation TEXT`);
    if (!names.has("handling")) this.raw.exec(`ALTER TABLE items ADD COLUMN handling INTEGER NOT NULL DEFAULT 0`);
    if (!names.has("triage")) this.raw.exec(`ALTER TABLE items ADD COLUMN triage TEXT`);
    if (!names.has("snooze_count")) {
      this.raw.exec(`ALTER TABLE items ADD COLUMN snooze_count INTEGER NOT NULL DEFAULT 0`);
      // Snoozes before the column existed are in the metrics log.
      this.raw.exec(`UPDATE items SET snooze_count = (SELECT COUNT(*) FROM metrics_events WHERE name = 'item.snoozed' AND ref = items.id)`);
    }
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
    if (!taskNames.has("parent_task_id")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`);
    if (!taskNames.has("spec")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN spec TEXT`);
    if (!taskNames.has("epic_id")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN epic_id TEXT`);
    if (!taskNames.has("epic_out")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN epic_out INTEGER NOT NULL DEFAULT 0`);
    if (!taskNames.has("design_version")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN design_version INTEGER`);
    if (!taskNames.has("amendment")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN amendment TEXT`);
    if (!taskNames.has("amendment_hash")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN amendment_hash TEXT`);
    if (!taskNames.has("jira_status")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN jira_status TEXT`);
    if (!taskNames.has("repeat_of")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN repeat_of TEXT`);
    if (!taskNames.has("retry_of")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN retry_of TEXT`);
    if (!taskNames.has("merged_ms")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN merged_ms INTEGER`);
    if (!taskNames.has("merge_readiness")) this.raw.exec(`ALTER TABLE tasks ADD COLUMN merge_readiness TEXT`);
    const epicCols = this.raw.prepare("PRAGMA table_info(epics)").all() as { name: string }[];
    if (!epicCols.some((c) => c.name === "design_block_hash")) this.raw.exec(`ALTER TABLE epics ADD COLUMN design_block_hash TEXT`);
    if (!epicCols.some((c) => c.name === "favorite_name")) this.raw.exec(`ALTER TABLE epics ADD COLUMN favorite_name TEXT`);
    if (!epicCols.some((c) => c.name === "repo_path")) this.raw.exec(`ALTER TABLE epics ADD COLUMN repo_path TEXT NOT NULL DEFAULT ''`);
    const repoCols = this.raw.prepare("PRAGMA table_info(repos)").all() as { name: string }[];
    if (!repoCols.some((c) => c.name === "context")) this.raw.exec(`ALTER TABLE repos ADD COLUMN context TEXT`);
    // Indexes covering hot queries and migrated columns (e.g. tasks.epic_id).
    this.raw.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_jira_key ON tasks(jira_key);
      CREATE INDEX IF NOT EXISTS idx_tasks_epic ON tasks(epic_id, jira_key, created_ms);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_task_events_ts ON task_events(ts, id);
      CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_items_status_created ON items(status, created_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_items_kind_status_created ON items(kind, status, created_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_items_task_kind_status_created ON items(task_id, kind, status, created_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_items_source_kind_status_created ON items(source_ref, kind, status, created_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_name_ref_id ON metrics_events(name, ref, id);
      CREATE INDEX IF NOT EXISTS idx_metrics_name_id ON metrics_events(name, id DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_events(ts);
      CREATE INDEX IF NOT EXISTS idx_epic_amendments_item ON epic_amendments(item_id);
      CREATE INDEX IF NOT EXISTS idx_kpi_measurements_history ON kpi_measurements(kpi_id, to_day DESC, from_day DESC);
    `);
    // Task history arrived after tasks did: give every pre-existing task the one
    // event its row still knows the time of, so a history never starts blank.
    // Flagged as backfilled — the other events happened at unknown times.
    this.raw.exec(`
      INSERT INTO task_events (task_id, ts, kind, message, data)
      SELECT id, created_ms, 'created', 'Task created (history starts here)', '{"backfilled":true}'
      FROM tasks
      WHERE NOT EXISTS (SELECT 1 FROM task_events WHERE task_events.task_id = tasks.id)
    `);
    // Earlier sweeps logged "Worktree cleanup failed" on every PR sync for the
    // same broken task. Collapse consecutive identical failures, keeping the first.
    this.raw.exec(`
      DELETE FROM task_events
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 kind,
                 message,
                 data,
                 LAG(kind) OVER (PARTITION BY task_id ORDER BY ts, id) AS prev_kind,
                 LAG(message) OVER (PARTITION BY task_id ORDER BY ts, id) AS prev_message,
                 LAG(data) OVER (PARTITION BY task_id ORDER BY ts, id) AS prev_data
          FROM task_events
          WHERE task_id IN (
            SELECT task_id FROM task_events
            WHERE kind = 'session' AND message = 'Worktree cleanup failed'
            GROUP BY task_id HAVING COUNT(*) > 1
          )
        )
        WHERE kind = 'session'
          AND message = 'Worktree cleanup failed'
          AND prev_kind = 'session'
          AND prev_message = 'Worktree cleanup failed'
          AND COALESCE(data, '') = COALESCE(prev_data, '')
      )
    `);
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }

  // ---- tasks ----

  insertTask(t: Task): void {
    this.stmt(
      `INSERT INTO tasks (id, title, prompt, repo_path, target, target_state, base_branch, branch,
        worktree_path, assignee, jira_key, jira_url, jira_parent_key, jira_status, pr_url, pr_meta, handoff, status, terminal_address,
        exit_code, created_ms, updated_ms, model, reasoning, agent, kind, review, parent_task_id, spec, epic_id, repeat_of, retry_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.id, t.title, t.prompt, t.repo_path, t.target, t.target_state, t.base_branch, t.branch,
      t.worktree_path, t.assignee, t.jira_key, t.jira_url, t.jira_parent_key, t.jira_status ?? null, t.pr_url, t.pr_meta ?? null,
      t.handoff ?? null, t.status, t.terminal_address, t.exit_code, t.created_ms, t.updated_ms, t.model ?? null, t.reasoning ?? null, t.agent ?? null,
      t.kind ?? "code", t.review ?? null, t.parent_task_id ?? null, t.spec ?? null, t.epic_id ?? null, t.repeat_of ?? null, t.retry_of ?? null,
    );
  }

  updateTask(id: string, patch: Partial<Task>, touch = true): void {
    const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof Task)[];
    if (keys.length === 0) return;
    // Read before writing only when a history-tracked field is patched; internal
    // bookkeeping writes (like pr_meta snapshots) skip the extra SELECT.
    const before = keys.some((k) => TRACKED_TASK_FIELDS.has(k)) ? this.getTask(id) : null;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as never);
    // Internal bookkeeping (a PR snapshot) must not make a stale task look
    // recently active: touch=false keeps updated_ms untouched.
    if (touch) this.stmt(`UPDATE tasks SET ${sets}, updated_ms = ? WHERE id = ?`).run(...values, Date.now(), id);
    else this.stmt(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...values, id);
    if (before) logTaskChanges(this, before, patch);
  }

  /** Create a task and its attachments together: a task never exists without
   *  the files it was created with. */
  insertTaskWithAttachments(t: Task, files: { filename: string; content_type: string; data: Uint8Array }[]): void {
    this.raw.exec("BEGIN");
    try {
      this.insertTask(t);
      const insertAttachment = this.stmt(
        `INSERT INTO task_attachments (id, task_id, filename, content_type, bytes, data, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      files.forEach((f, i) => {
        // created_ms + index keeps the order the files were dropped in.
        insertAttachment.run(randomUUID(), t.id, f.filename, f.content_type, f.data.length, f.data, t.created_ms + i);
      });
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  /** Attachment metadata of one task, in drop order. */
  listTaskAttachments(taskId: string): TaskAttachment[] {
    return this.stmt(
      `SELECT id, task_id, filename, content_type, bytes, created_ms FROM task_attachments WHERE task_id = ? ORDER BY created_ms, rowid`,
    ).all(taskId) as unknown as TaskAttachment[];
  }

  /** Attachments with their bytes, for dispatch. */
  taskAttachmentFiles(taskId: string): { filename: string; contentType: string; data: Uint8Array }[] {
    const rows = this.stmt(
      `SELECT filename, content_type, data FROM task_attachments WHERE task_id = ? ORDER BY created_ms, rowid`,
    ).all(taskId) as unknown as { filename: string; content_type: string; data: Uint8Array }[];
    return rows.map((r) => ({ filename: r.filename, contentType: r.content_type, data: r.data }));
  }

  /** How many files each task carries (tasks without any are absent). */
  attachmentCounts(): Map<string, number> {
    const rows = this.stmt(`SELECT task_id, COUNT(*) AS n FROM task_attachments GROUP BY task_id`).all() as unknown as { task_id: string; n: number }[];
    return new Map(rows.map((r) => [r.task_id, Number(r.n)]));
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

  /** Done tasks of one repo, newest first: the candidates a new task may repeat. */
  listDoneTasksInRepo(repoPath: string, limit = 500): Task[] {
    return this.stmt(`SELECT * FROM tasks WHERE status = 'done' AND repo_path = ? ORDER BY updated_ms DESC LIMIT ?`).all(repoPath, limit) as unknown as Task[];
  }

  /** Tasks archived or failed (non-zero exit) since `since`, any repo: the
   *  candidates a new task may retry. `ended_ms` is the last status change in
   *  the task history: later writes (cleanup, PR sync) also move updated_ms,
   *  so it cannot date the archive. */
  listEndedTasksSince(since: number): (Task & { ended_ms: number })[] {
    return this.stmt(`SELECT * FROM (
        SELECT t.*, COALESCE((SELECT MAX(e.ts) FROM task_events e WHERE e.task_id = t.id AND e.kind = 'status'), t.updated_ms) AS ended_ms
        FROM tasks t WHERE t.status = 'archived' OR (t.status = 'done' AND COALESCE(t.exit_code, 0) != 0)
      ) WHERE ended_ms >= ? ORDER BY ended_ms DESC`).all(since) as unknown as (Task & { ended_ms: number })[];
  }

  /** Fetch a set of tasks by id without scanning the full table. */
  getTasksByIds(ids: string[]): Task[] {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const out: Task[] = [];
    // Variable-arity IN clauses bypass `this.stmt` so they never evict hot statements.
    for (let i = 0; i < unique.length; i += 400) {
      const chunk = unique.slice(i, i + 400);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.raw.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`).all(...chunk) as unknown as Task[];
      out.push(...rows);
    }
    return out;
  }

  listPrCandidateTasks(): Task[] {
    return this.stmt(
      `SELECT * FROM tasks
       WHERE status IN ('dispatched', 'done')
         AND kind NOT IN ('review', 'spec', 'analysis', 'ops', 'grill')
         AND branch IS NOT NULL AND branch != ''
         AND repo_path != ''
       ORDER BY created_ms DESC`,
    ).all() as unknown as Task[];
  }

  listCleanupCandidateTasks(): Task[] {
    return this.stmt(
      `SELECT * FROM tasks
       WHERE status IN ('done', 'archived')
         AND worktree_path IS NOT NULL AND worktree_path != ''
         AND terminal_address IS NOT NULL AND terminal_address != ''
         AND NOT EXISTS (
           SELECT 1 FROM items
           WHERE items.task_id = tasks.id AND items.kind = 'pr' AND items.status = 'open'
         )
       ORDER BY created_ms DESC`,
    ).all() as unknown as Task[];
  }

  /** Events for tasks in registered professional repositories, in chronological order. */
  listDailyActivity(start: number, end: number): DailyActivity[] {
    return this.stmt(`SELECT e.*, t.title, t.prompt, r.name AS repo_name, r.path AS repo_path, t.jira_url, t.jira_key, t.pr_url, t.terminal_address
      FROM task_events e JOIN tasks t ON t.id = e.task_id JOIN repos r ON r.path = t.repo_path
      WHERE COALESCE(r.context, 'professional') = 'professional' AND e.ts >= ? AND e.ts < ?
      ORDER BY e.ts, e.id`).all(start, end) as unknown as DailyActivity[];
  }

  // ---- epics ----

  insertEpic(e: Epic): void {
    this.stmt(`INSERT INTO epics (id, jira_key, title, description, error, favorite_name, repo_path, synced_ms, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.id, e.jira_key, e.title, e.description, e.error, e.favorite_name ?? null, e.repo_path ?? "", e.synced_ms, e.created_ms);
  }

  updateEpic(id: string, patch: Partial<Pick<Epic, "title" | "description" | "error" | "synced_ms" | "design_block_hash" | "favorite_name" | "repo_path">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    this.stmt(`UPDATE epics SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => patch[k] as never), id);
  }

  getEpic(id: string): Epic | null {
    return (this.stmt(`SELECT * FROM epics WHERE id = ?`).get(id) as unknown as Epic) ?? null;
  }

  getEpicByKey(key: string): Epic | null {
    return (this.stmt(`SELECT * FROM epics WHERE jira_key = ?`).get(key) as unknown as Epic) ?? null;
  }

  listEpics(): Epic[] {
    return this.stmt(`SELECT * FROM epics ORDER BY created_ms DESC`).all() as unknown as Epic[];
  }

  /** Remove an epic and its epic-owned records while preserving linked Corral tasks. */
  deleteEpic(id: string): { deleted: boolean; archivedItemIds: string[]; detachedTaskIds: string[] } {
    if (!this.getEpic(id)) return { deleted: false, archivedItemIds: [], detachedTaskIds: [] };
    this.raw.exec("BEGIN");
    try {
      const amendmentItems = this.stmt(
        `SELECT DISTINCT i.id FROM items i JOIN epic_amendments a ON a.item_id = i.id WHERE a.epic_id = ? AND i.status = 'open'`,
      ).all(id) as unknown as { id: string }[];
      const launchItems = this.stmt(
        `SELECT DISTINCT i.id FROM items i JOIN tasks t ON t.id = i.task_id WHERE t.epic_id = ? AND i.kind = 'launch' AND i.status = 'open'`,
      ).all(id) as unknown as { id: string }[];
      const archivedItemIds = [...new Set([...amendmentItems, ...launchItems].map((r) => r.id))];
      const now = Date.now();
      for (const itemId of archivedItemIds) {
        this.stmt(`UPDATE items SET status = 'archived', resolved_ms = ?, updated_ms = ? WHERE id = ?`).run(now, now, itemId);
      }

      const detachedTaskIds = (
        this.stmt(`SELECT id FROM tasks WHERE epic_id = ?`).all(id) as unknown as { id: string }[]
      ).map((r) => r.id);
      this.stmt(`UPDATE tasks SET epic_id = NULL, epic_out = 0 WHERE epic_id = ?`).run(id);

      this.stmt(`DELETE FROM epic_links WHERE epic_id = ?`).run(id);
      this.stmt(`DELETE FROM epic_tickets WHERE epic_id = ?`).run(id);
      this.stmt(`DELETE FROM epic_designs WHERE epic_id = ?`).run(id);
      this.stmt(`DELETE FROM epic_amendments WHERE epic_id = ?`).run(id);
      this.stmt(`DELETE FROM epic_agents WHERE epic_id = ?`).run(id);
      this.stmt(`DELETE FROM epics WHERE id = ?`).run(id);

      this.raw.exec("COMMIT");
      return { deleted: true, archivedItemIds, detachedTaskIds };
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  listEpicTasks(epicId: string): Task[] {
    return this.stmt(`SELECT * FROM tasks WHERE epic_id = ? ORDER BY jira_key, created_ms`).all(epicId) as unknown as Task[];
  }

  listAllEpicTasks(): Task[] {
    return this.stmt(`SELECT * FROM tasks WHERE epic_id IS NOT NULL ORDER BY jira_key, created_ms`).all() as unknown as Task[];
  }

  listEpicLinks(epicId: string): EpicLink[] {
    return this.stmt(`SELECT * FROM epic_links WHERE epic_id = ? ORDER BY task_key, blocked_by_key`).all(epicId) as unknown as EpicLink[];
  }

  listAllEpicLinks(): EpicLink[] {
    return this.stmt(`SELECT * FROM epic_links ORDER BY epic_id, task_key, blocked_by_key`).all() as unknown as EpicLink[];
  }

  replaceEpicLinks(epicId: string, links: { task_key: string; blocked_by_key: string }[]): void {
    this.raw.exec("BEGIN");
    try {
      this.stmt(`DELETE FROM epic_links WHERE epic_id = ?`).run(epicId);
      for (const l of links) this.stmt(`INSERT OR IGNORE INTO epic_links (epic_id, task_key, blocked_by_key) VALUES (?, ?, ?)`).run(epicId, l.task_key, l.blocked_by_key);
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  listEpicTickets(epicId: string): EpicTicket[] {
    return this.stmt(`SELECT * FROM epic_tickets WHERE epic_id = ? ORDER BY jira_key`).all(epicId) as unknown as EpicTicket[];
  }

  getEpicTicket(epicId: string, jiraKey: string): EpicTicket | null {
    return (this.stmt(`SELECT * FROM epic_tickets WHERE epic_id = ? AND jira_key = ?`).get(epicId, jiraKey) as unknown as EpicTicket) ?? null;
  }

  replaceEpicTickets(epicId: string, tickets: EpicTicket[]): void {
    this.raw.exec("BEGIN");
    try {
      this.stmt(`DELETE FROM epic_tickets WHERE epic_id = ?`).run(epicId);
      const insert = this.stmt(`
        INSERT OR REPLACE INTO epic_tickets
          (epic_id, jira_key, title, description, jira_url, jira_status, jira_parent_key, suggested_repo_path, updated_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of tickets) {
        insert.run(t.epic_id, t.jira_key, t.title, t.description, t.jira_url, t.jira_status, t.jira_parent_key, t.suggested_repo_path, t.updated_ms);
      }
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- epic designs and amendments ----

  insertDesign(d: EpicDesign): void {
    this.stmt(`INSERT INTO epic_designs (epic_id, version, body, reason, author, created_ms) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(d.epic_id, d.version, d.body, d.reason, d.author, d.created_ms);
  }

  latestDesign(epicId: string): EpicDesign | null {
    return (this.stmt(`SELECT * FROM epic_designs WHERE epic_id = ? ORDER BY version DESC LIMIT 1`).get(epicId) as unknown as EpicDesign) ?? null;
  }

  listDesigns(epicId: string): EpicDesign[] {
    return this.stmt(`SELECT * FROM epic_designs WHERE epic_id = ? ORDER BY version DESC`).all(epicId) as unknown as EpicDesign[];
  }

  countDesigns(epicId: string): number {
    return (this.stmt(`SELECT COUNT(*) AS n FROM epic_designs WHERE epic_id = ?`).get(epicId) as { n: number }).n;
  }

  insertAmendment(a: EpicAmendment): void {
    this.stmt(`INSERT INTO epic_amendments (id, epic_id, task_id, design_version, body, status, item_id, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.epic_id, a.task_id, a.design_version, a.body, a.status, a.item_id, a.created_ms);
  }

  getAmendment(id: string): EpicAmendment | null {
    return (this.stmt(`SELECT * FROM epic_amendments WHERE id = ?`).get(id) as unknown as EpicAmendment) ?? null;
  }

  getAmendmentByItem(itemId: string): EpicAmendment | null {
    return (this.stmt(`SELECT * FROM epic_amendments WHERE item_id = ?`).get(itemId) as unknown as EpicAmendment) ?? null;
  }

  listAmendments(epicId: string, status?: EpicAmendment["status"]): EpicAmendment[] {
    return (status
      ? this.stmt(`SELECT * FROM epic_amendments WHERE epic_id = ? AND status = ? ORDER BY created_ms`).all(epicId, status)
      : this.stmt(`SELECT * FROM epic_amendments WHERE epic_id = ? ORDER BY created_ms`).all(epicId)) as unknown as EpicAmendment[];
  }

  updateAmendment(id: string, patch: Partial<Pick<EpicAmendment, "status" | "item_id">>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    this.stmt(`UPDATE epic_amendments SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => patch[k] as never), id);
  }

  // ---- task history ----

  insertTaskEvent(e: Omit<TaskEvent, "id">): void {
    this.stmt(`INSERT INTO task_events (task_id, ts, kind, message, data) VALUES (?, ?, ?, ?, ?)`).run(
      e.task_id, e.ts, e.kind, e.message, e.data,
    );
  }

  /** One task's history, oldest first (the order a timeline reads in). */
  listTaskEvents(taskId: string, limit = 500): TaskEvent[] {
    // Newest N by rowid, then flipped back to chronological order: a very long
    // history keeps its most recent events, in reading order.
    const rows = this.stmt(
      `SELECT * FROM (SELECT * FROM task_events WHERE task_id = ? ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts ASC, id ASC`,
    ).all(taskId, limit);
    return rows as unknown as TaskEvent[];
  }

  /** Every worktree path a task was given, oldest first. Worktree cleanup
   *  clears tasks.worktree_path; the history keeps the path, so usage logged
   *  in that worktree can still be attributed to its task. */
  listTaskWorktrees(): { task_id: string; path: string }[] {
    return this.stmt(`
      SELECT task_id, path FROM (
        SELECT task_id, ts, id, json_extract(data, '$.to') AS path FROM task_events
        WHERE kind = 'session' AND message LIKE 'Worktree: %' AND json_valid(data)
        UNION ALL
        SELECT task_id, ts, id, json_extract(data, '$.worktree') AS path FROM task_events
        WHERE kind = 'prompt' AND json_valid(data)
      )
      WHERE typeof(path) = 'text' AND path <> ''
      ORDER BY ts, id
    `).all() as unknown as { task_id: string; path: string }[];
  }

  // ---- items ----

  insertItem(i: Item): void {
    this.stmt(
      `INSERT INTO items (id, kind, status, title, summary, body, context, options, ready, handling, source_ref, task_id, structured,
        created_ms, updated_ms, resolved_ms, snooze_until_ms, elicitation, triage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      i.id, i.kind, i.status, i.title, i.summary, i.body, i.context, i.options, i.ready, i.handling ?? 0, i.source_ref, i.task_id,
      i.structured, i.created_ms, i.updated_ms, i.resolved_ms, i.snooze_until_ms, i.elicitation ?? null, i.triage ?? null,
    );
  }

  updateItem(id: string, patch: Partial<Item>): void {
    const keys = Object.keys(patch).filter((k) => k !== "id") as (keyof Item)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${String(k)} = ?`).join(", ");
    const values = keys.map((k) => patch[k] as never);
    this.stmt(`UPDATE items SET ${sets}, updated_ms = ? WHERE id = ?`).run(...values, Date.now(), id);
  }

  /** Snooze an item and count it, so repeated snoozes can be flagged. */
  snoozeItem(id: string, untilMs: number): void {
    this.stmt(`UPDATE items SET snooze_until_ms = ?, snooze_count = snooze_count + 1, updated_ms = ? WHERE id = ?`).run(untilMs, Date.now(), id);
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

  findPrItemForTask(taskId: string, opts: { includeArchived?: boolean } = {}): Item | null {
    const sql = opts.includeArchived
      ? `SELECT * FROM items WHERE task_id = ? AND kind = 'pr' ORDER BY CASE WHEN status = 'archived' THEN 1 ELSE 0 END ASC, created_ms DESC LIMIT 1`
      : `SELECT * FROM items WHERE task_id = ? AND kind = 'pr' AND status != 'archived' ORDER BY created_ms DESC LIMIT 1`;
    return (this.stmt(sql).get(taskId) as unknown as Item) ?? null;
  }

  hasOpenPrItem(taskId: string): boolean {
    return Boolean(this.stmt(`SELECT 1 FROM items WHERE task_id = ? AND kind = 'pr' AND status = 'open' LIMIT 1`).get(taskId));
  }

  listActivePrItems(): Item[] {
    return this.stmt(`SELECT * FROM items WHERE kind = 'pr' AND status != 'archived' ORDER BY created_ms DESC`).all() as unknown as Item[];
  }

  listTaskIdsWithActivePrItem(): string[] {
    const rows = this.stmt(`SELECT DISTINCT task_id FROM items WHERE kind = 'pr' AND status != 'archived' AND task_id IS NOT NULL`).all() as { task_id: string }[];
    return rows.map((r) => r.task_id);
  }

  findOpenItemForTask(taskId: string, kind: ItemKind): Item | null {
    return (this.stmt(`SELECT * FROM items WHERE task_id = ? AND kind = ? AND status = 'open' ORDER BY created_ms DESC LIMIT 1`).get(taskId, kind) as unknown as Item) ?? null;
  }

  listOpenItemsForTask(taskId: string, kind: ItemKind): Item[] {
    return this.stmt(`SELECT * FROM items WHERE task_id = ? AND kind = ? AND status = 'open' ORDER BY created_ms DESC`).all(taskId, kind) as unknown as Item[];
  }

  listUnarchivedItemsForTask(taskId: string): Item[] {
    return this.stmt(`SELECT * FROM items WHERE task_id = ? AND status != 'archived' ORDER BY created_ms DESC`).all(taskId) as unknown as Item[];
  }

  hasOpenItemFor(address: string, taskId: string): boolean {
    return Boolean(
      this.stmt(`SELECT 1 FROM items WHERE source_ref = ? AND status = 'open' LIMIT 1`).get(address)
      || this.stmt(`SELECT 1 FROM items WHERE task_id = ? AND status = 'open' LIMIT 1`).get(taskId),
    );
  }

  listSnoozedOpenItemsFor(opts: { taskId?: string | null; address?: string | null; now?: number }): Item[] {
    const { taskId = null, address = null, now = Date.now() } = opts;
    if (!taskId && !address) return [];
    const byId = new Map<string, Item>();
    if (taskId) {
      for (const item of this.stmt(`SELECT * FROM items WHERE task_id = ? AND status = 'open' AND snooze_until_ms > ? ORDER BY created_ms DESC`).all(taskId, now) as unknown as Item[]) {
        byId.set(item.id, item);
      }
    }
    if (address) {
      for (const item of this.stmt(`SELECT * FROM items WHERE source_ref = ? AND status = 'open' AND snooze_until_ms > ? ORDER BY created_ms DESC`).all(address, now) as unknown as Item[]) {
        byId.set(item.id, item);
      }
    }
    return [...byId.values()].sort((a, b) => b.created_ms - a.created_ms);
  }

  openQuestionItemForTerminal(address: string): Item | null {
    const row = this.stmt(`SELECT * FROM items WHERE source_ref = ? AND kind = 'question' AND status = 'open' ORDER BY created_ms DESC LIMIT 1`).get(address);
    return (row as unknown as Item) ?? null;
  }

  openQuestionItemForTask(taskId: string): Item | null {
    const row = this.stmt(`SELECT * FROM items WHERE task_id = ? AND kind = 'question' AND status = 'open' ORDER BY created_ms DESC LIMIT 1`).get(taskId);
    return (row as unknown as Item) ?? null;
  }

  openQuestionItemsFor(opts: { address?: string | null; taskId?: string | null }): Item[] {
    const { address, taskId } = opts;
    if (address && taskId) {
      const byTask = this.stmt(
        `SELECT * FROM items WHERE task_id = ? AND kind = 'question' AND status = 'open' ORDER BY created_ms DESC`,
      ).all(taskId) as unknown as Item[];
      const bySource = this.stmt(
        `SELECT * FROM items WHERE source_ref = ? AND kind = 'question' AND status = 'open' AND task_id IS NULL ORDER BY created_ms DESC`,
      ).all(address) as unknown as Item[];
      return [...byTask, ...bySource].sort((a, b) => b.created_ms - a.created_ms);
    }
    if (taskId) {
      return this.stmt(`SELECT * FROM items WHERE task_id = ? AND kind = 'question' AND status = 'open' ORDER BY created_ms DESC`).all(taskId) as unknown as Item[];
    }
    if (address) {
      return this.stmt(`SELECT * FROM items WHERE source_ref = ? AND kind = 'question' AND status = 'open' ORDER BY created_ms DESC`).all(address) as unknown as Item[];
    }
    return [];
  }

  questionItemForTerminal(address: string): Item | null {
    const row = this.stmt(`SELECT * FROM items WHERE source_ref = ? AND kind = 'question' AND status IN ('open', 'resolved') ORDER BY created_ms DESC LIMIT 1`).get(address);
    return (row as unknown as Item) ?? null;
  }

  latestQuestionItemForTerminal(address: string): Item | null {
    const row = this.stmt(`SELECT * FROM items WHERE source_ref = ? AND kind = 'question' ORDER BY created_ms DESC LIMIT 1`).get(address);
    return (row as unknown as Item) ?? null;
  }

  // ---- repos ----

  insertRepo(r: Repo): void {
    this.stmt(`INSERT OR IGNORE INTO repos (id, name, path, jira_prefix, context, source, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
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
    const row = this.stmt(`SELECT * FROM repos WHERE UPPER(jira_prefix) = ? ORDER BY created_ms LIMIT 1`)
      .get(prefix.toUpperCase());
    return (row as unknown as Repo) ?? null;
  }

  listRepos(): Repo[] {
    return this.stmt(`SELECT * FROM repos ORDER BY name`).all() as unknown as Repo[];
  }

  // ---- terminals ----

  upsertTerminal(t: TrackedTerminal): void {
    this.stmt(
      `INSERT INTO terminals (address, task_id, name, agent, last_status, last_turn, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         task_id = COALESCE(excluded.task_id, terminals.task_id),
         name = COALESCE(excluded.name, terminals.name),
         agent = COALESCE(excluded.agent, terminals.agent),
         last_status = COALESCE(excluded.last_status, terminals.last_status),
         last_turn = excluded.last_turn,
         updated_ms = excluded.updated_ms`,
    ).run(t.address, t.task_id, t.name, t.agent, t.last_status, t.last_turn, t.updated_ms);
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
    this.stmt(`INSERT INTO metrics_events (ts, name, ref, data) VALUES (?, ?, ?, ?)`)
      .run(Date.now(), name, ref, data === undefined || data === null ? null : JSON.stringify(data));
  }

  metricSummary(): { name: string; count: number; last_ms: number }[] {
    return this.stmt(`SELECT name, COUNT(*) AS count, MAX(ts) AS last_ms FROM metrics_events GROUP BY name ORDER BY count DESC`)
      .all() as unknown as { name: string; count: number; last_ms: number }[];
  }

  recentMetrics(limit = 50): MetricEvent[] {
    return this.stmt(`SELECT * FROM metrics_events ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as MetricEvent[];
  }

  // ---- plan revisions and reviews ----

  insertPlanRevision(rev: PlanRevision): void {
    this.stmt(
      `INSERT INTO plan_revisions (id, task_id, version, title, contract, subtasks_json, markdown, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(rev.id, rev.task_id, rev.version, rev.title, rev.contract, JSON.stringify(rev.subtasks), rev.markdown, rev.created_ms);
  }

  listPlanRevisions(taskId: string): PlanRevision[] {
    const rows = this.stmt(
      `SELECT id, task_id, version, title, contract, subtasks_json, markdown, created_ms
       FROM plan_revisions WHERE task_id = ? ORDER BY version ASC`,
    ).all(taskId) as unknown as {
      id: string; task_id: string; version: number; title: string; contract: string; subtasks_json: string; markdown: string; created_ms: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      task_id: r.task_id,
      version: r.version,
      title: r.title,
      contract: r.contract,
      subtasks: JSON.parse(r.subtasks_json) as PlanSubtask[],
      markdown: r.markdown,
      created_ms: r.created_ms,
    }));
  }

  getLatestPlanRevision(taskId: string): PlanRevision | null {
    const r = this.stmt(
      `SELECT id, task_id, version, title, contract, subtasks_json, markdown, created_ms
       FROM plan_revisions WHERE task_id = ? ORDER BY version DESC LIMIT 1`,
    ).get(taskId) as unknown as {
      id: string; task_id: string; version: number; title: string; contract: string; subtasks_json: string; markdown: string; created_ms: number;
    } | undefined;
    if (!r) return null;
    return {
      id: r.id,
      task_id: r.task_id,
      version: r.version,
      title: r.title,
      contract: r.contract,
      subtasks: JSON.parse(r.subtasks_json) as PlanSubtask[],
      markdown: r.markdown,
      created_ms: r.created_ms,
    };
  }

  insertPlanReview(review: PlanReview): void {
    this.stmt(
      `INSERT INTO plan_reviews (id, task_id, revision_id, note, comments_json, created_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(review.id, review.task_id, review.revision_id, review.note, JSON.stringify(review.comments), review.created_ms);
  }

  listPlanReviews(taskId: string): PlanReview[] {
    const rows = this.stmt(
      `SELECT id, task_id, revision_id, note, comments_json, created_ms
       FROM plan_reviews WHERE task_id = ? ORDER BY created_ms ASC, rowid ASC`,
    ).all(taskId) as unknown as {
      id: string; task_id: string; revision_id: string; note: string; comments_json: string; created_ms: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      task_id: r.task_id,
      revision_id: r.revision_id,
      note: r.note,
      comments: JSON.parse(r.comments_json) as PlanReviewComment[],
      created_ms: r.created_ms,
    }));
  }
}
