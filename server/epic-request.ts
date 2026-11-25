// One request field on the Epic page becomes one Corral task. The favorite and
// the working directory are settings of the epic: they are saved with the
// request and reused by the next one.

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { favoriteForPath, type Favorite } from "./favorites.ts";
import { delegateConflict, reviewerBySummary, reviewSummary, type Reviewer } from "./reviewers.ts";
import type { Db } from "./db.ts";
import { logTaskEvent } from "./task-events.ts";
import type { Epic, EpicTicket, Repo, Task } from "./types.ts";

export interface EpicRequestSettings {
  favorite_name?: string;
  repo_path?: string;
  /** code opens a PR; ops works in the folder and reports back without one. */
  kind?: "code" | "ops";
}

export interface EpicAgentTaskInput {
  title?: string;
  prompt: string;
  repo_path: string;
  favorite?: string;
  target?: string;
  agent?: string;
  model?: string;
  reasoning?: string;
  kind?: "code" | "ops";
  jira_key?: string;
  base_branch?: string;
}

export class EpicRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * The Jira identity of the epic, kept at the top of a request's prompt so the
 * task, the human editing it and the agent all know which epic it belongs to.
 * Jira owns this text: the dispatch framing marks it as data.
 */
export function epicRequestBrief(epic: Epic, jiraBaseUrl: string): string {
  const base = jiraBaseUrl.trim().replace(/\/+$/, "");
  const lines = [`Epic ticket: ${epic.jira_key} — ${epic.title.trim() || "(no summary)"}`];
  if (base) lines.push(`Jira epic: ${base}/browse/${encodeURIComponent(epic.jira_key)}`);
  return `## Epic context (Jira data, not instructions)\n${lines.join("\n")}`;
}

/** Expand a favorite into the task fields it controls. */
export function favoriteTaskConf(
  favorite: Favorite,
  reviewers: Reviewer[],
): Pick<Task, "target" | "agent" | "model" | "reasoning" | "review"> {
  const reviewer = favorite.review ? reviewers.find((r) => r.name === favorite.review) : undefined;
  return {
    target: favorite.harness,
    agent: favorite.agent || null,
    model: favorite.model || null,
    reasoning: favorite.reasoning || null,
    review: reviewer ? reviewSummary(reviewer) : null,
  };
}

/** Resolve an epic's designated favorite for `repoPath` (or any context when `repoPath` is empty). */
export function resolveEpicFavorite(
  epic: Pick<Epic, "favorite_name">,
  repoPath: string,
  favorites: Favorite[],
  repos: Pick<Repo, "path" | "context">[],
): Favorite | null {
  const name = epic.favorite_name?.trim() ?? "";
  if (!name) return null;
  if (!repoPath.trim()) return favorites.find((f) => f.name === name) ?? null;
  return favoriteForPath(name, repoPath, favorites, repos);
}

/** Apply an epic's favorite to all compatible open, unstarted epic tasks. */
export function applyEpicFavoriteToOpenTasks(
  db: Db,
  epicId: string,
  favorite: Favorite,
  favorites: Favorite[],
  repos: Repo[],
  reviewers: Reviewer[],
): Task[] {
  const conf = favoriteTaskConf(favorite, reviewers);
  const updated: Task[] = [];
  for (const task of db.listEpicTasks(epicId)) {
    if (task.status !== "open" || task.terminal_address) continue;
    if (task.repo_path.trim() && !favoriteForPath(favorite.name, task.repo_path, favorites, repos)) continue;
    db.updateTask(task.id, conf);
    const next = db.getTask(task.id);
    if (next) updated.push(next);
  }
  return updated;
}

/** A favorite only applies to a folder in the same context, as on the task form.
 *  When no folder is set yet, any configured favorite is valid. */
export function resolveEpicRequestSettings(
  input: EpicRequestSettings,
  favorites: Favorite[],
  repos: Repo[],
): { favorite: Favorite | null; repoPath: string } {
  const favoriteName = typeof input.favorite_name === "string" ? input.favorite_name.trim() : "";
  const repoPath = typeof input.repo_path === "string" ? input.repo_path.trim() : "";
  // Any path is allowed, as on the task form. Registered repos are only used
  // to pick the favorite context; an unregistered path uses professional.
  const favorite = !favoriteName
    ? null
    : repoPath
      ? favoriteForPath(favoriteName, repoPath, favorites, repos)
      : (favorites.find((f) => f.name === favoriteName) ?? null);
  if (favoriteName && !favorite) throw new EpicRequestError("favorite is not configured for this working directory");
  return { favorite, repoPath };
}

/** Remember the picks even when the human only changes the selectors. */
export function saveEpicRequestSettings(db: Db, epic: Epic, input: EpicRequestSettings, favorites: Favorite[]): void {
  const { favorite, repoPath } = resolveEpicRequestSettings(input, favorites, db.listRepos());
  db.updateEpic(epic.id, { favorite_name: favorite?.name ?? null, repo_path: repoPath });
}

/** Create an open, linked task: the human launches it from the Tasks page. */
export function createEpicRequestTask(
  db: Db,
  epic: Epic,
  input: EpicRequestSettings & { request: string },
  favorites: Favorite[],
  reviewers: Reviewer[],
  jiraBaseUrl: string = "",
): Task {
  const request = input.request.trim();
  if (!request || request.length > 8000) throw new EpicRequestError("request must be between 1 and 8000 characters");
  const kind = input.kind ?? "ops";
  if (kind !== "code" && kind !== "ops") throw new EpicRequestError("kind must be code or ops");
  const { favorite, repoPath } = resolveEpicRequestSettings(input, favorites, db.listRepos());
  const reviewer = favorite?.review ? reviewers.find((r) => r.name === favorite.review) : undefined;
  const review = reviewer ? reviewSummary(reviewer) : null;
  const now = Date.now();
  const task: Task = {
    id: randomUUID(),
    title: request.split("\n")[0].trim().slice(0, 120) || "Epic request",
    prompt: `${epicRequestBrief(epic, jiraBaseUrl)}\n\n${request}`,
    kind,
    repo_path: repoPath,
    target: favorite?.harness ?? "",
    target_state: "suggested",
    agent: favorite?.agent || null,
    model: favorite?.model || null,
    reasoning: favorite?.reasoning || null,
    review,
    base_branch: null,
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: null,
    pr_meta: null,
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    epic_id: epic.id,
  };
  db.insertTask(task);
  db.updateEpic(epic.id, { favorite_name: favorite?.name ?? null, repo_path: repoPath });
  db.recordMetric("task.created", task.id, { source: "epic_request", epic: epic.jira_key });
  logTaskEvent(db, task.id, "created", "Task created from an epic request", {
    source: "epic_request", epic: epic.jira_key, kind, repo: repoPath || null, favorite: favorite?.name ?? null,
  });
  return task;
}

export function resolveAgentRepoPath(raw: string, repos: Repo[]): string {
  const wanted = raw.trim();
  if (!wanted) throw new EpicRequestError("repo_path is required");
  const lower = wanted.toLowerCase();
  const matched = repos.find(
    (r) => r.path === wanted || r.name.toLowerCase() === lower || r.path.split("/").pop()?.toLowerCase() === lower,
  );
  if (matched) return matched.path;
  if (!isAbsolute(wanted)) throw new EpicRequestError("repo_path must be a registered repository name or an absolute path");
  return wanted;
}

export interface ResolvedEpicLaunchOptions {
  target: string;
  agent: string | null;
  model: string | null;
  reasoning: string | null;
  reviewName: string | null;
  frozenReview: string | null;
  baseBranch?: string | null;
  explicitOverride: boolean;
}

function optionalBodyString(b: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in b) || b[field] === undefined) return undefined;
  const val = b[field];
  if (val === null) return null;
  if (typeof val !== "string") throw new EpicRequestError(`${field} must be a string or null`);
  return val.trim() || null;
}

/**
 * Resolve effective dispatch settings for launching a ready epic ticket or task.
 * Precedence: explicit request `favorite`/`target` > existing task `target` >
 * compatible epic favorite > 400 error.
 */
export function resolveEpicLaunchOptions(opts: {
  epic: Pick<Epic, "favorite_name">;
  repoPath: string;
  existingTask?: Pick<Task, "target" | "agent" | "model" | "reasoning" | "review"> | null;
  body: unknown;
  favorites: Favorite[];
  repos: Repo[];
  reviewers: Reviewer[];
  configuredAgents?: string[];
}): ResolvedEpicLaunchOptions {
  const raw = opts.body;
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new EpicRequestError("launch body must be an object");
  }
  const b = (raw ?? {}) as Record<string, unknown>;
  const rawFav = "favorite" in b ? b.favorite : b.favorite_name;
  if (rawFav !== undefined && rawFav !== null && typeof rawFav !== "string") {
    throw new EpicRequestError("favorite must be a string");
  }
  const favoriteName = typeof rawFav === "string" ? rawFav.trim() : "";
  if ("target" in b && b.target !== undefined && b.target !== null && typeof b.target !== "string") {
    throw new EpicRequestError("target must be a string");
  }
  const explicitTarget = typeof b.target === "string" ? b.target.trim() : "";
  const explicitAgent = optionalBodyString(b, "agent");
  const explicitModel = optionalBodyString(b, "model");
  const explicitReasoning = optionalBodyString(b, "reasoning");
  const baseBranch = optionalBodyString(b, "base_branch");
  const configuredAgents = opts.configuredAgents ?? [];
  const existing = opts.existingTask ?? null;
  const explicitOverride = Boolean(
    favoriteName || explicitTarget || explicitAgent !== undefined || explicitModel !== undefined ||
    explicitReasoning !== undefined || baseBranch !== undefined,
  );

  if (favoriteName) {
    const favorite = favoriteForPath(favoriteName, opts.repoPath, opts.favorites, opts.repos);
    if (!favorite) throw new EpicRequestError(`favorite ${favoriteName} is not configured for this repository`);
    const target = explicitTarget || favorite.harness;
    if (configuredAgents.length > 0 && !configuredAgents.includes(target)) {
      throw new EpicRequestError(`unknown harness: ${target}`);
    }
    const agent = explicitAgent !== undefined ? explicitAgent : (favorite.agent || null);
    const model = explicitModel !== undefined ? explicitModel : (favorite.model || null);
    const reasoning = explicitReasoning !== undefined ? explicitReasoning : (favorite.reasoning || null);
    const reviewer = favorite.review ? opts.reviewers.find((r) => r.name === favorite.review) : undefined;
    if (reviewer) {
      const conflict = delegateConflict(reviewer, target, agent);
      if (conflict) throw new EpicRequestError(conflict);
    }
    return {
      target,
      agent,
      model,
      reasoning,
      reviewName: reviewer ? reviewer.name : null,
      frozenReview: reviewer ? reviewSummary(reviewer) : null,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      explicitOverride: true,
    };
  }

  if (explicitTarget) {
    if (configuredAgents.length > 0 && !configuredAgents.includes(explicitTarget)) {
      throw new EpicRequestError(`unknown harness: ${explicitTarget}`);
    }
    const agent = explicitAgent !== undefined ? explicitAgent : (existing?.agent ?? null);
    const model = explicitModel !== undefined ? explicitModel : (existing?.model ?? null);
    const reasoning = explicitReasoning !== undefined ? explicitReasoning : (existing?.reasoning ?? null);
    const savedReviewer = existing ? reviewerBySummary(existing.review, opts.reviewers) : undefined;
    const validReviewer = savedReviewer && !delegateConflict(savedReviewer, explicitTarget, agent) ? savedReviewer : undefined;
    return {
      target: explicitTarget,
      agent,
      model,
      reasoning,
      reviewName: validReviewer ? validReviewer.name : null,
      frozenReview: validReviewer ? reviewSummary(validReviewer) : null,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      explicitOverride: true,
    };
  }

  if (existing?.target) {
    const target = existing.target;
    const agent = explicitAgent !== undefined ? explicitAgent : (existing.agent ?? null);
    const model = explicitModel !== undefined ? explicitModel : (existing.model ?? null);
    const reasoning = explicitReasoning !== undefined ? explicitReasoning : (existing.reasoning ?? null);
    const savedReviewer = reviewerBySummary(existing.review, opts.reviewers);
    const validReviewer = savedReviewer && !delegateConflict(savedReviewer, target, agent) ? savedReviewer : undefined;
    return {
      target,
      agent,
      model,
      reasoning,
      reviewName: validReviewer ? validReviewer.name : null,
      frozenReview: validReviewer ? reviewSummary(validReviewer) : null,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      explicitOverride,
    };
  }

  if (opts.epic.favorite_name?.trim()) {
    const epicFavorite = resolveEpicFavorite(opts.epic, opts.repoPath, opts.favorites, opts.repos);
    if (!epicFavorite) {
      throw new EpicRequestError(
        `epic favorite "${opts.epic.favorite_name}" is not configured for this task's repository — configure the task or assign a compatible favorite`,
      );
    }
    const target = epicFavorite.harness;
    const agent = explicitAgent !== undefined ? explicitAgent : (existing?.agent ?? (epicFavorite.agent || null));
    const model = explicitModel !== undefined ? explicitModel : (existing?.model ?? (epicFavorite.model || null));
    const reasoning = explicitReasoning !== undefined ? explicitReasoning : (existing?.reasoning ?? (epicFavorite.reasoning || null));
    const favReviewer = epicFavorite.review
      ? opts.reviewers.find((r) => r.name === epicFavorite.review) ?? null
      : existing ? reviewerBySummary(existing.review, opts.reviewers) ?? null : null;
    if (favReviewer) {
      const conflict = delegateConflict(favReviewer, target, agent);
      if (conflict) throw new EpicRequestError(conflict);
    }
    return {
      target,
      agent,
      model,
      reasoning,
      reviewName: favReviewer ? favReviewer.name : null,
      frozenReview: favReviewer ? reviewSummary(favReviewer) : null,
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      explicitOverride,
    };
  }

  throw new EpicRequestError(
    existing ? "task has no harness — set one on the task before launching" : "favorite or target (harness) is required",
  );
}

/**
 * Create an open Corral code task from a synced `epic_tickets` row using the
 * validated repository and launch settings, ready for immediate dispatch.
 */
export function createTaskFromEpicTicket(
  db: Db,
  epic: Epic,
  ticket: EpicTicket,
  repoPath: string,
  conf: ResolvedEpicLaunchOptions,
): Task {
  const now = Date.now();
  const title = ticket.title.trim() || ticket.jira_key;
  const prompt = ticket.description.trim() || title;
  const task: Task = {
    id: randomUUID(),
    title,
    prompt,
    kind: "code",
    repo_path: repoPath,
    target: conf.target,
    target_state: "suggested",
    agent: conf.agent,
    model: conf.model,
    reasoning: conf.reasoning,
    review: conf.frozenReview,
    base_branch: conf.baseBranch ?? null,
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: ticket.jira_key,
    jira_url: ticket.jira_url || null,
    jira_parent_key: ticket.jira_parent_key ?? epic.jira_key,
    jira_status: ticket.jira_status,
    pr_url: null,
    pr_meta: null,
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    epic_id: epic.id,
    epic_out: 0,
  };
  db.insertTask(task);
  db.recordMetric("task.created", task.id, { source: "epic_launch", epic: epic.jira_key });
  logTaskEvent(db, task.id, "created", `Task created from epic ticket ${ticket.jira_key}`, {
    source: "epic_launch",
    epic: epic.jira_key,
    repo: repoPath,
    target: conf.target,
    agent: conf.agent,
    jira_key: ticket.jira_key,
  });
  return task;
}

/**
 * Create an open task linked to an epic on behalf of the epic agent, in the
 * chosen repository and with the chosen favorite/harness/agent settings.
 * Never auto-dispatches and never overwrites the epic's UI request defaults.
 */
export function createEpicAgentTask(
  db: Db,
  epic: Epic,
  input: EpicAgentTaskInput,
  favorites: Favorite[],
  reviewers: Reviewer[],
  configuredAgents: string[] = [],
  jiraBaseUrl: string = "",
): Task {
  const rawPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!rawPrompt || rawPrompt.length > 20_000) throw new EpicRequestError("prompt must be between 1 and 20000 characters");
  const rawTitle = typeof input.title === "string" ? input.title.trim() : "";
  if (rawTitle.length > 300) throw new EpicRequestError("title must be at most 300 characters");
  const title = rawTitle || rawPrompt.split("\n")[0].trim().slice(0, 120) || "Epic task";
  const kind = input.kind ?? "code";
  if (kind !== "code" && kind !== "ops") throw new EpicRequestError("kind must be code or ops");

  const repos = db.listRepos();
  const repoPath = resolveAgentRepoPath(typeof input.repo_path === "string" ? input.repo_path : "", repos);

  const favoriteName = typeof input.favorite === "string" ? input.favorite.trim() : "";
  const explicitTarget = typeof input.target === "string" ? input.target.trim() : "";
  let favorite = favoriteName ? favoriteForPath(favoriteName, repoPath, favorites, repos) : null;
  if (favoriteName && !favorite) throw new EpicRequestError(`favorite ${favoriteName} is not configured for this repository`);

  if (!favoriteName && !explicitTarget && epic.favorite_name?.trim()) {
    const epicFavoriteName = epic.favorite_name.trim();
    favorite = favoriteForPath(epicFavoriteName, repoPath, favorites, repos);
    if (!favorite) {
      throw new EpicRequestError(`epic favorite ${epicFavoriteName} is not configured for this repository — pass a compatible favorite or target`);
    }
  }

  const target = explicitTarget || favorite?.harness || "";
  if (!target) throw new EpicRequestError("favorite or target (harness) is required");
  if (configuredAgents.length > 0 && !configuredAgents.includes(target)) {
    throw new EpicRequestError(`unknown harness: ${target}`);
  }

  const agent = (typeof input.agent === "string" ? input.agent.trim() : "") || favorite?.agent || null;
  const model = (typeof input.model === "string" ? input.model.trim() : "") || favorite?.model || null;
  const reasoning = (typeof input.reasoning === "string" ? input.reasoning.trim() : "") || favorite?.reasoning || null;
  const reviewer = favorite?.review ? reviewers.find((r) => r.name === favorite.review) : undefined;
  const review = reviewer && !delegateConflict(reviewer, target, agent) ? reviewSummary(reviewer) : null;
  const baseBranch = typeof input.base_branch === "string" && input.base_branch.trim() ? input.base_branch.trim() : null;

  const jiraKey = typeof input.jira_key === "string" && input.jira_key.trim() ? input.jira_key.trim().toUpperCase() : null;
  let jiraUrl: string | null = null;
  let jiraParentKey: string | null = null;
  let jiraStatus: string | null = null;
  if (jiraKey) {
    const existing = db.getTaskByJiraKey(jiraKey);
    if (existing && existing.status !== "archived") {
      throw new EpicRequestError(`a task for Jira ticket ${jiraKey} already exists (id: ${existing.id}) — update it with PATCH /api/tasks/${existing.id}`, 409);
    }
    const ticket = db.getEpicTicket(epic.id, jiraKey);
    const base = jiraBaseUrl.trim().replace(/\/+$/, "");
    jiraUrl = ticket?.jira_url || (base ? `${base}/browse/${encodeURIComponent(jiraKey)}` : null);
    jiraParentKey = ticket?.jira_parent_key ?? epic.jira_key;
    jiraStatus = ticket?.jira_status ?? null;
  }

  const prompt = rawPrompt.startsWith("## Epic context")
    ? rawPrompt
    : `${epicRequestBrief(epic, jiraBaseUrl)}\n\n${rawPrompt}`;

  const now = Date.now();
  const task: Task = {
    id: randomUUID(),
    title,
    prompt,
    kind,
    repo_path: repoPath,
    target,
    target_state: "suggested",
    agent,
    model,
    reasoning,
    review,
    base_branch: baseBranch,
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: jiraKey,
    jira_url: jiraUrl,
    jira_parent_key: jiraParentKey,
    jira_status: jiraStatus,
    pr_url: null,
    pr_meta: null,
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    epic_id: epic.id,
  };
  db.insertTask(task);
  db.recordMetric("task.created", task.id, { source: "epic_agent", epic: epic.jira_key });
  logTaskEvent(db, task.id, "created", `Task created by epic agent for ${epic.jira_key}`, {
    source: "epic_agent", epic: epic.jira_key, kind, repo: repoPath, target, agent, favorite: favorite?.name ?? null, jira_key: jiraKey,
  });
  return task;
}

/**
 * Normalize and validate a PATCH /api/tasks/:id payload so callers (including
 * the epic agent and epic request tasks) can assign a repository by registered
 * name or absolute path and apply a favorite (expanding harness, agent, model,
 * reasoning and review) or explicit harness/agent settings on existing tasks.
 */
export function resolveTaskPatch(
  task: Task,
  rawBody: unknown,
  repos: Repo[],
  favorites: Favorite[],
  reviewers: Reviewer[],
  configuredAgents: string[] = [],
  epicFavoriteName: string | null = null,
): Partial<Task> {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    throw new EpicRequestError("patch body must be an object");
  }
  const input = { ...(rawBody as Record<string, unknown>) };
  delete input.id;
  delete input.kind; // fixed at creation: dispatch and the PR loop depend on it

  // Support `repo` as an alias for `repo_path` without leaking an unknown column to SQLite.
  const hasRepoAlias = "repo" in input;
  const repoAlias = input.repo;
  delete input.repo;
  if (!("repo_path" in input) && hasRepoAlias) {
    input.repo_path = repoAlias;
  }

  if ("repo_path" in input) {
    if (typeof input.repo_path !== "string") throw new EpicRequestError("repo_path must be a string");
    const trimmed = input.repo_path.trim();
    input.repo_path = trimmed ? resolveAgentRepoPath(trimmed, repos) : "";
  }

  // Extract `favorite` / `favorite_name` before building the SQL patch.
  const hasFavorite = "favorite" in input || "favorite_name" in input;
  const rawFavorite = "favorite" in input ? input.favorite : input.favorite_name;
  delete input.favorite;
  delete input.favorite_name;

  let favorite: Favorite | null = null;
  if (hasFavorite && rawFavorite !== null && rawFavorite !== undefined) {
    if (typeof rawFavorite !== "string") throw new EpicRequestError("favorite must be a string");
    const favoriteName = rawFavorite.trim();
    if (favoriteName) {
      const effectiveRepoPath = typeof input.repo_path === "string" ? input.repo_path : task.repo_path;
      favorite = favoriteForPath(favoriteName, effectiveRepoPath, favorites, repos);
      if (!favorite) throw new EpicRequestError(`favorite ${favoriteName} is not configured for this repository`);
    }
  }

  if ("target" in input) {
    if (typeof input.target !== "string") throw new EpicRequestError("target must be a string");
    const target = input.target.trim();
    if (target && configuredAgents.length > 0 && !configuredAgents.includes(target)) {
      throw new EpicRequestError(`unknown harness: ${target}`);
    }
    input.target = target;
  }

  for (const field of ["agent", "model", "reasoning", "base_branch"] as const) {
    if (!(field in input)) continue;
    const val = input[field];
    if (val === null) continue;
    if (typeof val !== "string") throw new EpicRequestError(`${field} must be a string or null`);
    input[field] = val.trim() || null;
  }

  if (favorite) {
    const explicitTarget = typeof input.target === "string" ? input.target : "";
    const resolvedTarget = explicitTarget || favorite.harness;
    if (resolvedTarget && configuredAgents.length > 0 && !configuredAgents.includes(resolvedTarget)) {
      throw new EpicRequestError(`unknown harness: ${resolvedTarget}`);
    }
    input.target = resolvedTarget;
    if (!("agent" in input)) input.agent = favorite.agent || null;
    if (!("model" in input)) input.model = favorite.model || null;
    if (!("reasoning" in input)) input.reasoning = favorite.reasoning || null;
    if (!("review" in input)) {
      const reviewer = favorite.review ? reviewers.find((r) => r.name === favorite.review) : undefined;
      input.review = reviewer ? reviewSummary(reviewer) : null;
    }
  } else {
    if (("target" in input || "agent" in input) && !("review" in input)) {
      const nextTarget = typeof input.target === "string" ? input.target : task.target;
      const nextAgent = "agent" in input ? (input.agent as string | null) : (task.agent ?? null);
      const existingReviewer = reviewerBySummary(task.review, reviewers);
      if (existingReviewer && delegateConflict(existingReviewer, nextTarget, nextAgent)) {
        input.review = null;
      }
    }
    if (
      typeof input.repo_path === "string" &&
      input.repo_path !== "" &&
      task.status === "open" &&
      !task.terminal_address &&
      !task.target &&
      !hasFavorite &&
      !("target" in input) &&
      epicFavoriteName?.trim()
    ) {
      const epicFav = favoriteForPath(epicFavoriteName.trim(), input.repo_path, favorites, repos);
      if (epicFav && (configuredAgents.length === 0 || configuredAgents.includes(epicFav.harness))) {
        const conf = favoriteTaskConf(epicFav, reviewers);
        input.target = conf.target;
        if (!("agent" in input)) input.agent = conf.agent;
        if (!("model" in input)) input.model = conf.model;
        if (!("reasoning" in input)) input.reasoning = conf.reasoning;
        if (!("review" in input)) input.review = conf.review;
      }
    }
  }

  return input as Partial<Task>;
}
