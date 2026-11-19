// Epics: a Jira epic and its tickets as an ordered set of tasks. Jira owns the
// structure (tickets, "blocked by" links, titles, descriptions); Corral owns
// execution (PRs, repo per task). A sync pulls the structure again, any time,
// and never overwrites what Corral already started (see docs/adr/0001).

import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { blockedByEdges, descriptionToText, type JiraIssue } from "./jira.ts";
import { stripBlocks } from "./jira-blocks.ts";
import { logTaskEvent } from "./task-events.ts";
import type { Epic, Repo, Task } from "./types.ts";

/** The slice of the Jira client a sync needs (a fake in tests). */
export interface EpicJira {
  getIssue(key: string): Promise<JiraIssue>;
  epicChildren(key: string): Promise<JiraIssue[]>;
  issueToTaskFields(issue: JiraIssue): { title: string; prompt: string; jira_key: string; jira_url: string; jira_parent_key: string | null; jira_status: string | null };
}

export class EpicError extends Error {}

/** A ticket Jira reports as finished counts as merged for its dependents. */
export function isJiraDone(status: string | null | undefined): boolean {
  return /^(done|closed|resolved|terminé|résolu|clos|fermé)$/i.test((status ?? "").trim());
}

/** A Killed ticket was cancelled or replaced: terminal, but never merged. */
export function isJiraKilled(status: string | null | undefined): boolean {
  return /^killed$/i.test((status ?? "").trim());
}

/** The repo a ticket names on a `Repo: <name>` line (name, folder name or path), if Corral knows it. */
export function parseRepoLine(text: string, repos: Repo[]): Repo | null {
  const m = text.match(/^\s*repo\s*:\s*(.+?)\s*$/im);
  if (!m) return null;
  const wanted = m[1].replace(/[`*_]/g, "").trim().toLowerCase();
  if (!wanted) return null;
  return repos.find((r) => r.name.toLowerCase() === wanted || r.path.toLowerCase() === wanted || r.path.split("/").pop()?.toLowerCase() === wanted) ?? null;
}

/** One dependency cycle among the edges (keys in order), or null. */
export function findCycle(edges: { task_key: string; blocked_by_key: string }[]): string[] | null {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.task_key, [...(next.get(e.task_key) ?? []), e.blocked_by_key]);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (k: string): string[] | null => {
    if (state.get(k) === 2) return null;
    if (state.get(k) === 1) return [...stack.slice(stack.indexOf(k)), k];
    state.set(k, 1);
    stack.push(k);
    for (const n of next.get(k) ?? []) {
      const c = visit(n);
      if (c) return c;
    }
    stack.pop();
    state.set(k, 2);
    return null;
  };
  for (const k of next.keys()) {
    const c = visit(k);
    if (c) return c;
  }
  return null;
}

export interface EpicSyncResult {
  epic: Epic;
  created: string[];
  updated: string[];
  out: string[];
}

/**
 * Import or resync one epic. Tickets already known as tasks are attached;
 * a task that was already dispatched keeps its prompt and title. A ticket that
 * left the epic is flagged, not deleted.
 */
export async function syncEpic(db: Db, jira: EpicJira, key: string): Promise<EpicSyncResult> {
  const epicIssue = await jira.getIssue(key);
  const children = await jira.epicChildren(key);
  const now = Date.now();
  const title = epicIssue.fields.summary;
  // Corral's own blocks are not part of the epic's text: the design block is history, kept apart.
  const description = stripBlocks(descriptionToText(epicIssue.fields.description));
  let epic = db.getEpicByKey(key);
  if (!epic) {
    epic = { id: randomUUID(), jira_key: key, title, description, error: null, synced_ms: now, created_ms: now };
    db.insertEpic(epic);
    db.insertDesign({ epic_id: epic.id, version: 1, body: description, reason: "Imported from Jira", author: "jira", created_ms: now });
  } else {
    db.updateEpic(epic.id, { title, description, synced_ms: now });
  }
  const repos = db.listRepos();
  const result: EpicSyncResult = { epic, created: [], updated: [], out: [] };
  const present = new Set<string>();

  for (const issue of children) {
    const f = jira.issueToTaskFields(issue);
    f.prompt = stripBlocks(f.prompt); // the amendment block lives on the task, not in its prompt
    present.add(f.jira_key);
    const existing = db.getTaskByJiraKey(f.jira_key);
    if (!existing) {
      const repo = parseRepoLine(f.prompt, repos);
      const task: Task = {
        id: randomUUID(), title: f.title, prompt: f.prompt, kind: "code", repo_path: repo?.path ?? "", target: "", target_state: "suggested",
        base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: f.jira_key, jira_url: f.jira_url,
        jira_parent_key: f.jira_parent_key, jira_status: f.jira_status, pr_url: null, pr_meta: null, status: "open",
        terminal_address: null, exit_code: null, created_ms: now, updated_ms: now, epic_id: epic.id,
      };
      db.insertTask(task);
      db.recordMetric("task.created", task.id, { source: "epic" });
      logTaskEvent(db, task.id, "created", `Task created from epic ${key}`, { source: "epic", epic: key, repo: task.repo_path || null });
      result.created.push(f.jira_key);
      continue;
    }
    const patch: Partial<Task> = {};
    if (existing.epic_id !== epic.id) patch.epic_id = epic.id;
    if (existing.epic_out) patch.epic_out = 0;
    if (existing.jira_status !== f.jira_status) patch.jira_status = f.jira_status;
    // Jira wins on the ticket text until work starts; after that the running
    // agent's prompt is history and must not change under it.
    // A task a human wrote by hand (no Jira link) keeps its own text: only
    // Jira-sourced tasks are refreshed, and dispatch frames those as data.
    const started = existing.status !== "open" || Boolean(existing.terminal_address);
    if (!started && existing.jira_url) {
      if (existing.title !== f.title) patch.title = f.title;
      if (existing.prompt !== f.prompt) patch.prompt = f.prompt;
      if (!existing.repo_path) {
        const repo = parseRepoLine(f.prompt, repos);
        if (repo) patch.repo_path = repo.path;
      }
    }
    if (existing.jira_parent_key !== f.jira_parent_key) patch.jira_parent_key = f.jira_parent_key;
    if (Object.keys(patch).length) {
      db.updateTask(existing.id, patch, false);
      result.updated.push(f.jira_key);
    }
  }

  for (const task of db.listEpicTasks(epic.id)) {
    if (task.jira_key && !present.has(task.jira_key) && !task.epic_out) {
      db.updateTask(task.id, { epic_out: 1 }, false);
      logTaskEvent(db, task.id, "session", `Ticket left epic ${key}`, { epic: key });
      result.out.push(task.jira_key);
    }
  }

  const edges = blockedByEdges(children);
  db.replaceEpicLinks(epic.id, edges);
  const cycle = findCycle(edges);
  const error = cycle ? `Dependency cycle: ${cycle.join(" → ")}` : null;
  db.updateEpic(epic.id, { error });
  result.epic = db.getEpic(epic.id)!;
  db.recordMetric("epic.synced", epic.id, { key, tasks: children.length, created: result.created.length, out: result.out.length });
  return result;
}
