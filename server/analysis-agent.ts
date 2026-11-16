import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Hub } from "./capture.ts";
import { dispatchTask } from "./dispatch.ts";
import { gitToplevel } from "./repos.ts";
import { logTaskEvent } from "./task-events.ts";
import type { Task } from "./types.ts";
import type { WorkerBackend } from "./worker.ts";

export class AnalysisAgent {
  constructor(privateDb: Db, privateHub: Pick<Hub, "broadcast">, config: Config, worker: WorkerBackend) {
    this.db = privateDb; this.hub = privateHub; this.cfg = config; this.backend = worker;
    this.db.raw.exec("CREATE TABLE IF NOT EXISTS analysis_agent_settings (id INTEGER PRIMARY KEY CHECK(id = 1), repo TEXT NOT NULL DEFAULT '')");
    this.db.raw.exec("INSERT OR IGNORE INTO analysis_agent_settings (id) VALUES (1)");
  }
  private db: Db;
  private hub: Pick<Hub, "broadcast">;
  private cfg: Config;
  private backend: WorkerBackend;
  repo(): string { return (this.db.raw.prepare("SELECT repo FROM analysis_agent_settings WHERE id = 1").get() as { repo: string }).repo; }
  setRepo(repo: string): void {
    if (repo) gitToplevel(repo);
    this.db.raw.prepare("UPDATE analysis_agent_settings SET repo = ? WHERE id = 1").run(repo);
  }
  /** `repo` and harness settings override the Improve defaults for one analysis. */
  async start(title: string, prompt: string, opts: { repo?: string; target?: string; model?: string | null; reasoning?: string | null; agent?: string | null; source?: string } = {}): Promise<Task> {
    const repo = opts.repo ?? this.repo();
    if (!repo) throw new Error("Select a repository for Improve analyses first");
    const now = Date.now();
    const task: Task = { id: randomUUID(), title, prompt, kind: "analysis", repo_path: repo, target: opts.target ?? "claude", target_state: opts.target ? "confirmed" : "suggested", model: opts.model ?? null, reasoning: opts.reasoning ?? null, agent: opts.agent ?? null, base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null, status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now };
    this.db.insertTask(task);
    logTaskEvent(this.db, task.id, "created", "Analysis task created", { source: opts.source ?? "improve", harness: task.target });
    this.hub.broadcast("task.updated", task);
    try { await dispatchTask(this.db, this.cfg, this.backend, task, task.target, { useWorktree: false }); }
    catch (err) { this.hub.broadcast("task.updated", this.db.getTask(task.id)); throw err; }
    const dispatched = this.db.getTask(task.id)!;
    this.hub.broadcast("task.updated", dispatched);
    return dispatched;
  }
}
