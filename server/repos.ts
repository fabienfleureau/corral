// Repo registry: git repos Corral knows about. Fed by manual add and by
// scanning workspace roots; mapped to Jira projects by prefix.

import { existsSync, readdirSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Db } from "./db.ts";
import type { Repo } from "./types.ts";

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

export function addRepo(db: Db, path: string, opts: { name?: string; jiraPrefix?: string | null; source?: "manual" | "scan" } = {}): Repo {
  const existing = db.getRepoByPath(path);
  if (existing) return existing;
  const repo: Repo = {
    id: randomUUID(),
    name: opts.name ?? basename(path),
    path,
    jira_prefix: opts.jiraPrefix ?? null,
    context: null,
    source: opts.source ?? "manual",
    created_ms: Date.now(),
  };
  db.insertRepo(repo);
  db.recordMetric("repo.added", repo.id, { source: repo.source });
  return repo;
}

/** Validate a path is a git repo and return its toplevel (throwing otherwise). */
export function gitToplevel(path: string): string {
  return execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** All configured remote URLs of a repo, or none when the path is not a repo. */
export function gitRemoteUrls(path: string): string[] {
  try {
    const out = execFileSync("git", ["-C", path, "config", "--get-regexp", "^remote\\..*\\.url$"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return out.split("\n").map((line) => line.trim().split(/\s+/, 2)[1]).filter((url): url is string => !!url);
  } catch {
    return [];
  }
}

/**
 * Scan workspace roots (depth ≤ 2 below each root) for git repos.
 * Returns the repos added by this scan.
 */
export function scanWorkspaceRepos(db: Db, roots: string[], maxDepth = 2): Repo[] {
  const added: Repo[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (isGitRepo(dir) && !seen.has(dir)) {
      seen.add(dir);
      const before = db.getRepoByPath(dir);
      const repo = addRepo(db, dir, { source: "scan" });
      if (!before) added.push(repo);
      return; // don't descend into a repo's subdirectories
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "vendor") continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch {
        /* broken symlink etc. */
      }
    }
  };

  for (const root of roots) walk(root, 0);
  db.recordMetric("repo.scanned", null, { roots, added: added.length });
  return added;
}

/** Jira issue key prefix ("OPS" of "OPS-123") for repo mapping. */
export function jiraKeyPrefix(issueKey: string): string {
  const m = issueKey.match(/^([A-Za-z0-9]+)-/);
  return m ? m[1] : issueKey;
}

export interface ImportPreview {
  repo_path: string | null;
  repo_name: string | null;
  existing_task_id: string | null;
}

/** What importing this issue would do: target repo and whether a task already exists. */
export function importPreview(db: Db, issueKey: string): ImportPreview {
  const repo = db.getRepoByJiraPrefix(jiraKeyPrefix(issueKey));
  return {
    repo_path: repo?.path ?? null,
    repo_name: repo?.name ?? null,
    existing_task_id: db.getTaskByJiraKey(issueKey)?.id ?? null,
  };
}

/**
 * Hash of the task fields an import would write. Search returns it; import
 * re-checks it so a ticket or repo mapping that changed after review is not
 * imported unseen.
 */
export function importFingerprint(f: {
  title: string;
  prompt: string;
  jira_parent_key: string | null;
  repo_path: string | null;
}): string {
  const payload = JSON.stringify([f.title, f.prompt, f.jira_parent_key, f.repo_path]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
