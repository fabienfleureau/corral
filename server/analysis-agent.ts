import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Hub } from "./capture.ts";
import { dispatchTask } from "./dispatch.ts";
import { favoriteForPath } from "./favorites.ts";
import { gitToplevel } from "./repos.ts";
import { logTaskEvent } from "./task-events.ts";
import type { Task } from "./types.ts";
import type { WorkerBackend } from "./worker.ts";

export class AnalysisAgent {
  constructor(privateDb: Db, privateHub: Pick<Hub, "broadcast">, config: Config, worker: WorkerBackend) {
    this.db = privateDb; this.hub = privateHub; this.cfg = config; this.backend = worker;
    this.db.raw.exec("CREATE TABLE IF NOT EXISTS analysis_agent_settings (id INTEGER PRIMARY KEY CHECK(id = 1), repo TEXT NOT NULL DEFAULT '', favorite TEXT NOT NULL DEFAULT '')");
    const cols = this.db.raw.prepare("PRAGMA table_info(analysis_agent_settings)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "favorite")) {
      this.db.raw.exec("ALTER TABLE analysis_agent_settings ADD COLUMN favorite TEXT NOT NULL DEFAULT ''");
    }
    this.db.raw.exec("INSERT OR IGNORE INTO analysis_agent_settings (id) VALUES (1)");
  }
  private db: Db;
  private hub: Pick<Hub, "broadcast">;
  private cfg: Config;
  private backend: WorkerBackend;
  settings(): { repo: string; favorite: string } {
    const row = this.db.stmt("SELECT repo, favorite FROM analysis_agent_settings WHERE id = 1").get() as { repo: string; favorite: string };
    return { repo: row.repo, favorite: row.favorite };
  }
  repo(): string { return this.settings().repo; }
  favorite(): string { return this.settings().favorite; }
  setSettings(next: { repo?: string; favorite?: string }): { repo: string; favorite: string } {
    const current = this.settings();
    const nextRepo = next.repo !== undefined ? next.repo.trim() : current.repo;
    if (next.repo !== undefined && nextRepo) {
      try {
        gitToplevel(nextRepo);
      } catch {
        throw new Error("Repository must be an existing git repository");
      }
    }
    const favorites = this.cfg.favorites ?? [];
    const repos = this.db.listRepos();
    let nextFavorite: string;
    if (next.favorite !== undefined) {
      nextFavorite = next.favorite.trim();
      if (nextFavorite) {
        if (!nextRepo) throw new Error("Select a repository before choosing a favorite");
        if (!favoriteForPath(nextFavorite, nextRepo, favorites, repos)) {
          throw new Error(`Favorite "${nextFavorite}" is not configured for this repository's context`);
        }
      }
    } else {
      nextFavorite = current.favorite && nextRepo && favoriteForPath(current.favorite, nextRepo, favorites, repos)
        ? current.favorite
        : "";
    }
    this.db.stmt("UPDATE analysis_agent_settings SET repo = ?, favorite = ? WHERE id = 1").run(nextRepo, nextFavorite);
    return { repo: nextRepo, favorite: nextFavorite };
  }
  setRepo(repo: string): void {
    this.setSettings({ repo });
  }
  private resolveConf(repo: string): { target: string; targetState: "confirmed" | "suggested"; agent: string | null; model: string | null; reasoning: string | null } {
    const savedFavorite = this.favorite();
    const favorites = this.cfg.favorites ?? [];
    const repos = this.db.listRepos();
    if (savedFavorite) {
      const fav = favoriteForPath(savedFavorite, repo, favorites, repos);
      if (!fav) {
        throw new Error(`Favorite "${savedFavorite}" is not configured for this repository's context. Choose a matching favorite on the Improve page.`);
      }
      return {
        target: fav.harness,
        targetState: "confirmed",
        agent: fav.agent || null,
        model: fav.model || null,
        reasoning: fav.reasoning || null,
      };
    }
    const context = repos.find((r) => r.path === repo)?.context ?? "professional";
    const matching = favorites.filter((f) => (f.context ?? "professional") === context);
    if (matching.length > 0) {
      return {
        target: matching[0].harness,
        targetState: "suggested",
        agent: matching[0].agent || null,
        model: matching[0].model || null,
        reasoning: matching[0].reasoning || null,
      };
    }
    if (favorites.length > 0) {
      throw new Error(`No ${context} favorite configured in Settings for this repository. Add a ${context} favorite in Settings before running Improve analyses.`);
    }
    return { target: "claude", targetState: "suggested", agent: null, model: null, reasoning: null };
  }
  /** `repo` and harness settings override the Improve defaults for one analysis. */
  /** `ops` runs in any folder and reports back; `analysis` is the default. */
  async start(title: string, prompt: string, opts: { repo?: string; target?: string; model?: string | null; reasoning?: string | null; agent?: string | null; source?: string; kind?: "analysis" | "ops" } = {}): Promise<Task> {
    const repo = opts.repo ?? this.repo();
    if (!repo) throw new Error("Select a repository for Improve analyses first");
    const kind = opts.kind ?? "analysis";
    const conf = opts.target
      ? {
          target: opts.target,
          targetState: "confirmed" as const,
          agent: opts.agent ?? null,
          model: opts.model ?? null,
          reasoning: opts.reasoning ?? null,
        }
      : this.resolveConf(repo);
    const now = Date.now();
    const task: Task = {
      id: randomUUID(), title, prompt, kind, repo_path: repo,
      target: conf.target, target_state: conf.targetState,
      model: conf.model, reasoning: conf.reasoning, agent: conf.agent,
      base_branch: null, branch: null, worktree_path: null, assignee: null,
      jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null,
      status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now,
    };
    this.db.insertTask(task);
    logTaskEvent(this.db, task.id, "created", kind === "ops" ? "Action task created" : "Analysis task created", { source: opts.source ?? "improve", harness: task.target });
    this.hub.broadcast("task.updated", task);
    try {
      await dispatchTask(this.db, this.cfg, this.backend, task, task.target, {
        useWorktree: false,
        agent: task.agent,
        model: task.model,
        reasoning: task.reasoning,
      });
    } catch (err) { this.hub.broadcast("task.updated", this.db.getTask(task.id)); throw err; }
    const dispatched = this.db.getTask(task.id)!;
    this.hub.broadcast("task.updated", dispatched);
    return dispatched;
  }
}
