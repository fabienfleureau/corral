// Dispatch: turn a task into a running agent via the worker backend (omnigent).
// Worktrees are the backend's job — omnigent's host daemon creates them from
// the git request on session create.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { gitToplevel } from "./repos.ts";
import type { WorkerBackend, WorkerSession } from "./worker.ts";
import { taskLabel, type Task } from "./types.ts";

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

export function questionConvention(cfg: Config, task: Task): string {
  const read = (name: string, fallback: string): string => {
    const path = join(cfg.configDir, "skills", name);
    const local = join(process.cwd(), "skills", name);
    try {
      return readFileSync(existsSync(path) ? path : local, "utf8");
    } catch {
      return fallback;
    }
  };
  // A review must not commit, push or open a PR: its convention replaces both
  // the finish flow of question-report.md and the PR loop.
  const parts = task.kind === "review"
    ? [read("review.md", "Review the PR/MR. Do not change code. Ask before posting any comment.")]
    : [
      read("question-report.md", "When you need the human, ask clearly and wait. Do not guess."),
      read("pr-loop.md", ""),
    ];
  return parts.filter(Boolean).join("\n\n---\n\n")
    .replaceAll("{task_id}", task.id)
    .replaceAll("{corral_url}", `http://${cfg.host}:${cfg.port}`)
    .replaceAll("{corral_token}", cfg.token)
    .replaceAll("{pr_url}", task.pr_url ?? "");
}

/**
 * Best effort: pre-accept Claude Code's workspace-trust dialog for the
 * worktree omnigent is about to create (its path is predictable:
 * `<repo>-worktrees/<branch>`). Dispatching the task is the trust decision.
 */
function trustClaudeWorkspace(path: string): void {
  const file = join(homedir(), ".claude.json");
  try {
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    cfg.projects = cfg.projects ?? {};
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      /* the worktree may not exist yet — keep the predicted path */
    }
    for (const key of new Set([path, real])) {
      cfg.projects[key] = { ...(cfg.projects[key] ?? {}), hasTrustDialogAccepted: true };
    }
    writeFileSync(file, JSON.stringify(cfg, null, 2));
  } catch {
    /* worst case the trust dialog shows again */
  }
}

const execFileAsync = promisify(execFile);

async function worktreeBase(repo: string, base: string | null): Promise<string | null> {
  const git = async (...args: string[]) => (await execFileAsync("git", ["-C", repo, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })).stdout.trim();
  const remotes = (await git("remote")).split("\n");
  // A commit avoids Git's automatic upstream inference, which can fail when
  // multiple remotes map their fetch refspecs to the same tracking ref.
  const commit = (ref: string) => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  if (!remotes.includes("origin")) return base ? commit(base) : null;
  await git("fetch", "origin");
  if (base) {
    const branch = base.startsWith("origin/") ? base.slice("origin/".length) : base;
    const remoteRef = `refs/heads/${branch}`;
    const remoteBranch = await git("ls-remote", "--heads", "origin", remoteRef);
    if (remoteBranch.split("\n").some((line) => line.split("\t")[1] === remoteRef)) {
      // Explicit fetch works even when the clone tracks only its default branch.
      await git("fetch", "origin", remoteRef);
      return commit("FETCH_HEAD");
    }
    return commit(base);
  }
  const remoteHead = await git("ls-remote", "--symref", "origin", "HEAD");
  const branch = remoteHead.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1];
  if (!branch) throw new Error("origin has no default branch; set a base branch for this task");
  return commit(`origin/${branch}`);
}

export interface DispatchResult {
  address: string;
  worktreePath: string;
  branch: string;
}

export async function dispatchTask(
  db: Db,
  cfg: Config,
  backend: WorkerBackend,
  task: Task,
  target: string,
  opts: {
    useWorktree?: boolean;
    model?: string | null;
    reasoning?: string | null;
    agent?: string | null;
  } = {},
): Promise<DispatchResult> {
  if (!task.repo_path?.trim()) {
    throw new Error("task has no repo assigned — assign one before dispatching");
  }
  try {
    gitToplevel(task.repo_path);
  } catch {
    throw new Error(`not a git repository: ${task.repo_path}`);
  }

  const review = task.kind === "review";
  if (review) {
    if (target !== "claude") throw new Error("review tasks run on the claude harness only");
    if (!task.pr_url) throw new Error("review task has no PR/MR URL");
  }
  // A review reads the MR head without checking it out: no worktree, no branch.
  const useWorktree = !review && opts.useWorktree !== false;
  const originalBranch = task.branch ?? `${slugify(taskLabel(task), 32)}-${task.id.slice(0, 6)}`;
  let branch = originalBranch;

  // Untitled task: send no title so omnigent generates one; capture adopts it.
  const name = task.title.trim() ? `corral-${slugify(task.title, 24)}` : null;
  const taskContext = [...new Set([task.title.trim(), task.prompt.trim()].filter(Boolean))];
  if (task.jira_url) taskContext.push(`Jira: ${task.jira_url}`);
  if (review) taskContext.push(`Review this PR/MR: ${task.pr_url}`);
  const fullPrompt = `${taskContext.join("\n\n")}\n\n---\n${questionConvention(cfg, task)}`;

  let session: WorkerSession;
  try {
    const base = useWorktree ? await worktreeBase(task.repo_path, task.base_branch) : null;
    for (let attempt = 0; ; attempt++) {
      if (!useWorktree && target === "claude") trustClaudeWorkspace(task.repo_path);
      if (useWorktree && target === "claude") {
        trustClaudeWorkspace(`${task.repo_path}-worktrees/${branch}`);
        trustClaudeWorkspace(`${task.repo_path}-worktrees/${branch.replaceAll("/", "-")}`);
      }
      try {
        session = await backend.start({
          taskId: task.id,
          project: db.getRepoByPath(task.repo_path)?.name ?? task.repo_path,
          name,
          repoPath: task.repo_path,
          git: useWorktree ? { branch, base } : null,
          prompt: fullPrompt,
          harness: target,
          agent: opts.agent ?? null,
          model: opts.model === undefined ? task.model ?? null : opts.model,
          reasoning: opts.reasoning === undefined ? task.reasoning ?? null : opts.reasoning,
          env: {
            CORRAL_URL: `http://${cfg.host}:${cfg.port}`,
            CORRAL_TOKEN: cfg.token,
            CORRAL_TASK_ID: task.id,
          },
        });
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (!useWorktree || attempt >= 3 || !message.startsWith("omnigent POST /v1/sessions -> 400:") ||
            !message.includes(`worktree creation failed: a branch named '${branch}' already exists; choose a different branch name`)) throw err;
        branch = `${originalBranch}-${randomBytes(4).toString("hex")}`;
      }
    }
  } catch (err) {
    throw new Error(`dispatch failed: ${err instanceof Error ? err.message : err}`);
  }

  db.updateTask(task.id, {
    status: "dispatched",
    target,
    target_state: "confirmed",
    model: opts.model === undefined ? task.model ?? null : opts.model,
    reasoning: opts.reasoning === undefined ? task.reasoning ?? null : opts.reasoning,
    branch: review ? null : branch,
    worktree_path: useWorktree && session.cwd ? session.cwd : null,
    terminal_address: session.address,
  });
  db.upsertTerminal({
    address: session.address,
    task_id: task.id,
    name: session.name ?? name ?? null,
    agent: target,
    last_status: session.status,
    last_turn: session.turn ?? 0,
    updated_ms: Date.now(),
  });
  db.recordMetric("task.dispatched", task.id, {
    target,
    address: session.address,
    worktree: useWorktree,
    model: opts.model === undefined ? task.model ?? null : opts.model,
    reasoning: opts.reasoning === undefined ? task.reasoning ?? null : opts.reasoning,
  });

  return { address: session.address, worktreePath: session.cwd, branch: review ? "" : branch };
}
