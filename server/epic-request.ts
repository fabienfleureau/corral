// One request field on the Epic page becomes one Corral task. The favorite and
// the working directory are settings of the epic: they are saved with the
// request and reused by the next one.

import { randomUUID } from "node:crypto";
import { favoriteForPath, type Favorite } from "./favorites.ts";
import type { Reviewer } from "./reviewers.ts";
import type { Db } from "./db.ts";
import { logTaskEvent } from "./task-events.ts";
import type { Epic, Repo, Task } from "./types.ts";

export interface EpicRequestSettings {
  favorite_name?: string;
  repo_path?: string;
  /** code opens a PR; ops works in the folder and reports back without one. */
  kind?: "code" | "ops";
}

export class EpicRequestError extends Error {}

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
  const review = favorite?.review ? reviewers.find((r) => r.name === favorite.review)?.command ?? null : null;
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
