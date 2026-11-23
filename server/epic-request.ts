// One request field on the Epic page becomes one Corral task. The favorite and
// the working directory are settings of the epic: they are saved with the
// request and reused by the next one.

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { favoriteForPath, type Favorite } from "./favorites.ts";
import { reviewSummary, type Reviewer } from "./reviewers.ts";
import type { Db } from "./db.ts";
import { logTaskEvent } from "./task-events.ts";
import type { Epic, Repo, Task } from "./types.ts";

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

/** A favorite only applies to a folder in the same context, as on the task form. */
export function resolveEpicRequestSettings(
  input: EpicRequestSettings,
  favorites: Favorite[],
  repos: Repo[],
): { favorite: Favorite | null; repoPath: string } {
  const favoriteName = typeof input.favorite_name === "string" ? input.favorite_name.trim() : "";
  const repoPath = typeof input.repo_path === "string" ? input.repo_path.trim() : "";
  // Any path is allowed, as on the task form. Registered repos are only used
  // to pick the favorite context; an unregistered path uses professional.
  const favorite = favoriteForPath(favoriteName, repoPath, favorites, repos);
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
  const kind = input.kind ?? "code";
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

function resolveAgentRepoPath(raw: string, repos: Repo[]): string {
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
  const favorite = favoriteName ? favoriteForPath(favoriteName, repoPath, favorites, repos) : null;
  if (favoriteName && !favorite) throw new EpicRequestError(`favorite ${favoriteName} is not configured for this repository`);

  const target = (typeof input.target === "string" ? input.target.trim() : "") || favorite?.harness || "";
  if (!target) throw new EpicRequestError("favorite or target (harness) is required");
  if (configuredAgents.length > 0 && !configuredAgents.includes(target)) {
    throw new EpicRequestError(`unknown harness: ${target}`);
  }

  const agent = (typeof input.agent === "string" ? input.agent.trim() : "") || favorite?.agent || null;
  const model = (typeof input.model === "string" ? input.model.trim() : "") || favorite?.model || null;
  const reasoning = (typeof input.reasoning === "string" ? input.reasoning.trim() : "") || favorite?.reasoning || null;
  const reviewer = favorite?.review ? reviewers.find((r) => r.name === favorite.review) : undefined;
  const review = reviewer ? reviewSummary(reviewer) : null;
  const baseBranch = typeof input.base_branch === "string" && input.base_branch.trim() ? input.base_branch.trim() : null;

  const jiraKey = typeof input.jira_key === "string" && input.jira_key.trim() ? input.jira_key.trim().toUpperCase() : null;
  let jiraUrl: string | null = null;
  let jiraParentKey: string | null = null;
  let jiraStatus: string | null = null;
  if (jiraKey) {
    const existing = db.getTaskByJiraKey(jiraKey);
    if (existing && existing.status !== "archived") {
      throw new EpicRequestError(`a task for Jira ticket ${jiraKey} already exists`, 409);
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
