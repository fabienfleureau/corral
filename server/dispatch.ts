// Dispatch: turn a task into a running agent — git worktree, prompt assembly
// (with the question-report convention), and a herdr terminal.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { HerdrClient } from "./herdr.ts";
import type { Task } from "./types.ts";

export function slugify(s: string, max = 40): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "task";
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], // keep fallback probes quiet
  }).trim();
}

export function defaultBaseBranch(repoPath: string): string {
  try {
    const head = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (head) return head; // e.g. origin/main
  } catch {
    /* fall through */
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    try {
      git(repoPath, ["rev-parse", "--verify", candidate]);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return "HEAD";
}

/** Create (or reuse) a worktree for the task's branch. Returns its path. */
export function ensureWorktree(repoPath: string, branch: string, base: string | null, worktreesDir: string): string {
  git(repoPath, ["rev-parse", "--show-toplevel"]); // validates it's a git repo
  const repoName = basename(git(repoPath, ["rev-parse", "--show-toplevel"]));
  const dir = join(worktreesDir, repoName, branch);
  mkdirSync(join(worktreesDir, repoName), { recursive: true });
  if (existsSync(dir)) return dir;

  const branchExists = (() => {
    try {
      git(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  })();

  if (branchExists) {
    execFileSync("git", ["-C", repoPath, "worktree", "add", dir, branch], { encoding: "utf8" });
  } else {
    const from = base ?? defaultBaseBranch(repoPath);
    execFileSync("git", ["-C", repoPath, "worktree", "add", "-b", branch, dir, from], { encoding: "utf8" });
  }
  return dir;
}

/** Offer cleanup after a task is archived. */
export function removeWorktree(repoPath: string, worktreePath: string): void {
  execFileSync("git", ["-C", repoPath, "worktree", "remove", "--force", worktreePath], { encoding: "utf8" });
}

export function questionConvention(cfg: Config, task: Task): string {
  const path = join(cfg.configDir, "skills", "question-report.md");
  const fallback = join(process.cwd(), "skills", "question-report.md");
  const file = existsSync(path) ? path : fallback;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = "When you need the human, ask clearly and wait. Do not guess.";
  }
  return text
    .replaceAll("{task_id}", task.id)
    .replaceAll("{corral_url}", `http://${cfg.host}:${cfg.port}`)
    .replaceAll("{corral_token}", process.env.CORRAL_TOKEN ?? cfg.token);
}

export interface DispatchResult {
  address: string;
  worktreePath: string;
  branch: string;
}

export async function dispatchTask(
  db: Db,
  cfg: Config,
  herdr: HerdrClient,
  task: Task,
  target: string,
  opts: { useWorktree?: boolean } = {},
): Promise<DispatchResult> {
  const agentCmd = cfg.agents[target];
  if (!agentCmd) throw new Error(`unknown target "${target}" (configured: ${Object.keys(cfg.agents).join(", ")})`);

  const useWorktree = opts.useWorktree !== false;
  const branch = task.branch ?? `${slugify(task.title, 32)}-${task.id.slice(0, 6)}`;
  let worktreePath = task.repo_path;
  if (useWorktree) {
    worktreePath = ensureWorktree(task.repo_path, branch, task.base_branch, cfg.worktreesDir);
  }

  const fullPrompt = `${task.prompt.trim()}\n\n---\n${questionConvention(cfg, task)}`;
  const argv = agentCmd.map((part) => part.replaceAll("{prompt}", fullPrompt));
  const name = `corral-${slugify(task.title, 24)}`;

  const term = await herdr.run({
    argv,
    cwd: worktreePath,
    name,
    labels: {
      "corral.task": task.id,
      "corral.target": target,
    },
    env: {
      CORRAL_URL: `http://${cfg.host}:${cfg.port}`,
      CORRAL_TOKEN: cfg.token,
      CORRAL_TASK_ID: task.id,
    },
    outlive_parent: true,
    no_parent: true,
    keep: true,
  });

  db.updateTask(task.id, {
    status: "dispatched",
    target,
    target_state: "confirmed",
    branch,
    worktree_path: useWorktree ? worktreePath : null,
    terminal_address: term.address,
  });
  db.upsertTerminal({
    address: term.address,
    task_id: task.id,
    name: term.name ?? name,
    agent: target,
    last_status: term.status?.state ?? null,
    last_turn: term.turn ?? 0,
    updated_ms: Date.now(),
  });
  db.recordMetric("task.dispatched", task.id, { target, address: term.address, worktree: useWorktree });

  return { address: term.address, worktreePath, branch };
}
