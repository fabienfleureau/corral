// PR/MR readiness: Corral verifies — from the platform APIs — that a task's PR
// is actually ready for human review (exists, threads resolved, checks green,
// mergeable) before it is shown as such. And when review comments or merge
// conflicts appear, Corral feeds them back to the task's agent automatically (the PR loop in
// skills/pr-loop.md) so the human only ever sees "ready for review".

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { WorkerBackend } from "./worker.ts";
import type { Hub } from "./capture.ts";
import type { Item, Task } from "./types.ts";
import { taskLabel } from "./types.ts";
import { questionConvention, slugify } from "./dispatch.ts";

export interface PrThread {
  /** Stable id (GraphQL thread id, or GitLab discussion id) for dedupe. */
  id: string;
  author: string;
  body: string;
}

export interface PrInfo {
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED (upper)
  number: number;
  description: string;
  additions: number;
  deletions: number;
  changed_files: number;
  /** MERGEABLE | CONFLICTING | UNKNOWN (null when the platform says nothing) */
  mergeable: string | null;
  /** Branch the PR merges into (rebase target when conflicting). */
  base_ref: string | null;
  review_decision: string | null;
  checks: { total: number; failed: number; pending: boolean };
  /** Unresolved review threads — the "comments to manage". */
  threads: PrThread[];
}

export interface PrReady {
  ready: boolean;
  reasons: string[];
}

/** The gate: ready only when threads are resolved, checks green, mergeable. */
export function prReady(pr: PrInfo): PrReady {
  const reasons: string[] = [];
  if (pr.state !== "OPEN") reasons.push(`PR is ${pr.state.toLowerCase()}`);
  if (pr.threads.length > 0) {
    reasons.push(`${pr.threads.length} unresolved review comment${pr.threads.length === 1 ? "" : "s"}`);
  }
  if (pr.checks.pending) reasons.push("checks still running");
  if (pr.checks.failed > 0) reasons.push(`${pr.checks.failed} failing check${pr.checks.failed === 1 ? "" : "s"}`);
  if (pr.mergeable === "CONFLICTING") reasons.push("merge conflicts");
  else if (pr.state === "OPEN" && pr.mergeable !== "MERGEABLE") reasons.push("mergeability unknown");
  if (pr.review_decision === "CHANGES_REQUESTED") reasons.push("changes requested");
  return { ready: reasons.length === 0, reasons };
}

export function prItemBody(pr: PrInfo): string {
  const lines: string[] = [];
  const desc = pr.description.trim();
  if (desc) lines.push(desc.slice(0, 2000), "");
  lines.push(
    "| | |",
    "|---|---|",
    `| Files changed | ${pr.changed_files} |`,
    `| Lines | +${pr.additions} / -${pr.deletions} |`,
    `| Review comments | ${pr.threads.length} unresolved |`,
    `| Checks | ${pr.checks.total === 0 ? "none configured" : pr.checks.pending ? "running" : pr.checks.failed > 0 ? `${pr.checks.failed} failing` : "green"} |`,
    `| Mergeable | ${pr.mergeable ? pr.mergeable.toLowerCase() : "unknown"} |`,
    "",
    `PR: ${pr.url}`,
  );
  return lines.join("\n");
}

// ---- discovery ----

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd,
    timeout: 20_000, // never block the event loop on a stuck gh/glab call
  }).trim();
}

function repoSlug(repoPath: string): string | null {
  try {
    const url = run("git", ["remote", "get-url", "origin"], repoPath);
    const m = url.match(/[:/]([^:/]+)\/([^:/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

function summarizeChecks(rollup: unknown[]): PrInfo["checks"] {
  let failed = 0;
  let pending = 0;
  for (const raw of rollup) {
    const c = raw as Record<string, unknown>;
    const state = String(c.conclusion ?? c.state ?? "").toUpperCase();
    const status = String(c.status ?? "").toUpperCase();
    if (state === "SUCCESS" || state === "NEUTRAL" || state === "SKIPPED") continue;
    if (state === "" || state === "PENDING" || state === "EXPECTED" || state === "QUEUED" || status === "IN_PROGRESS" || status === "QUEUED") {
      pending++;
    } else {
      failed++;
    }
  }
  return { total: rollup.length, failed, pending: pending > 0 };
}

function findPrGitHub(repoPath: string, branch: string): PrInfo | null {
  const out = run(
    "gh",
    [
      "pr", "view", branch,
      "--json", "url,title,state,number,body,additions,deletions,changedFiles,mergeable,baseRefName,reviewDecision,statusCheckRollup",
    ],
    repoPath,
  );
  const d = JSON.parse(out) as Record<string, unknown>;
  const slug = repoSlug(repoPath);
  let threads: PrThread[] = [];
  if (slug) {
    // reviewThreads (unresolved) is only on GraphQL.
    const [owner, name] = slug.split("/");
    const query =
      `query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${Number(d.number)}){` +
      `reviewThreads(first:50){nodes{id isResolved comments(first:10){nodes{author{login} body}}}}}}}`;
    try {
      const gql = JSON.parse(run("gh", ["api", "graphql", "-f", `query=${query}`], repoPath)) as {
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown[] } } } };
      };
      const nodes = gql.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      for (const raw of nodes) {
        const t = raw as {
          id?: string;
          isResolved?: boolean;
          comments?: { nodes?: { author?: { login?: string }; body?: string }[] };
        };
        if (t.isResolved) continue;
        const comments = t.comments?.nodes ?? [];
        const first = comments[0];
        const last = comments[comments.length - 1];
        // "Answered" per the readiness rule: someone replied after the
        // reviewer. GitHub never auto-resolves a thread on reply — requiring
        // isResolved would keep the gate red forever.
        const answered =
          comments.length > 1 && (first?.author?.login ?? "") !== (last?.author?.login ?? "");
        if (answered) continue;
        threads.push({
          id: String(t.id ?? randomUUID()),
          author: String(first?.author?.login ?? "reviewer"),
          body: String(first?.body ?? "").slice(0, 2000),
        });
      }
    } catch {
      /* GraphQL unavailable: treat as no thread data */
    }
  }
  return {
    url: String(d.url),
    title: String(d.title),
    state: String(d.state).toUpperCase(),
    number: Number(d.number),
    description: String(d.body ?? ""),
    additions: Number(d.additions ?? 0),
    deletions: Number(d.deletions ?? 0),
    changed_files: Number(d.changedFiles ?? 0),
    mergeable: d.mergeable ? String(d.mergeable).toUpperCase() : null,
    base_ref: d.baseRefName ? String(d.baseRefName) : null,
    review_decision: d.reviewDecision ? String(d.reviewDecision).toUpperCase() : null,
    checks: summarizeChecks((d.statusCheckRollup as unknown[]) ?? []),
    threads,
  };
}

function findPrGitLab(repoPath: string, branch: string): PrInfo | null {
  // Best-effort: glab list -> api changes/discussions for stats and threads.
  const out = run("glab", ["mr", "list", "--source-branch", branch, "--all", "--output", "json"], repoPath);
  const list = JSON.parse(out) as Record<string, unknown>[];
  if (list.length === 0) return null;
  const mr = list[0];
  const iid = Number(mr.iid ?? 0);
  let description = String(mr.description ?? "");
  let additions = 0;
  let deletions = 0;
  let changed = 0;
  const threads: PrThread[] = [];
  try {
    const changes = JSON.parse(run("glab", ["api", `projects/:id/merge_requests/${iid}/changes`], repoPath)) as {
      changes?: { additions?: string; deletions?: string }[];
    };
    const diff = changes.changes ?? [];
    changed = diff.length;
    for (const c of diff) {
      additions += (c.additions ?? "").split("\n").filter((l) => l.startsWith("+")).length || 0;
      deletions += (c.deletions ?? "").split("\n").filter((l) => l.startsWith("-")).length || 0;
    }
    if (!description) {
      const full = JSON.parse(run("glab", ["api", `projects/:id/merge_requests/${iid}`], repoPath)) as {
        description?: string;
      };
      description = full.description ?? "";
    }
    const discussions = JSON.parse(run("glab", ["api", `projects/:id/merge_requests/${iid}/discussions`], repoPath)) as {
      id?: string;
      notes?: { resolvable?: boolean; resolved?: boolean; author?: { username?: string }; body?: string }[];
    }[];
    for (const d of discussions) {
      const note = d.notes?.[0];
      if (!note?.resolvable || note.resolved) continue;
      threads.push({
        id: String(d.id ?? randomUUID()),
        author: String(note.author?.username ?? "reviewer"),
        body: String(note.body ?? "").slice(0, 2000),
      });
    }
  } catch {
    /* degraded metadata is fine */
  }
  return {
    url: String(mr.web_url ?? ""),
    title: String(mr.title ?? ""),
    state: String(mr.state ?? "opened").toUpperCase() === "OPENED" ? "OPEN" : String(mr.state).toUpperCase(),
    number: iid,
    description,
    additions,
    deletions,
    changed_files: changed,
    mergeable: mr.has_conflicts === true ? "CONFLICTING" : mr.has_conflicts === false ? "MERGEABLE" : null,
    base_ref: mr.target_branch ? String(mr.target_branch) : null,
    review_decision: null,
    checks: { total: 0, failed: 0, pending: false },
    threads,
  };
}

export function findPr(repoPath: string, branch: string): PrInfo | null {
  if (!repoPath || !branch) return null;
  try {
    return findPrGitHub(repoPath, branch);
  } catch {
    /* not GitHub or gh missing — try GitLab */
  }
  try {
    return findPrGitLab(repoPath, branch);
  } catch {
    return null;
  }
}

// ---- the PR loop: feed comments back to the agent, automatically ----

function threadSignature(pr: PrInfo): string {
  return pr.threads.map((t) => t.id).sort().join(",");
}

function commentsSection(pr: PrInfo): string {
  const parts = pr.threads.map(
    (t, i) => `[${i + 1}] ${t.author} (thread ${t.id}):\n${t.body}`,
  );
  return [
    "PR review comments need handling — this is the PR loop, not a question:",
    "for each comment: fix the code (or reply on the thread if you disagree),",
    "then resolve the thread:",
    "  gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"<thread id>\"}){thread{isResolved}}}'",
    "run your tests, commit and push. Do not ask for permission. Do not merge the PR.",
    "",
    ...parts,
  ].join("\n");
}

function conflictSection(pr: PrInfo, task: Task): string {
  // The base ref lands in a shell command the agent runs: allow plain ref
  // names only (git permits `;`, `$`, backticks in branch names).
  const safe = (r: string | null) => (r && /^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/.test(r) ? r : null);
  const base = safe(pr.base_ref) ?? safe(task.base_branch) ?? "main";
  return [
    `PR merge conflicts need handling — the PR no longer merges cleanly into \`${base}\`.`,
    "Rebase and resolve them, automatically, without asking:",
    `  git fetch origin && git rebase origin/${base}`,
    "resolve each conflict keeping the intent of both sides (git add, git rebase --continue),",
    "run your tests, then push: git push --force-with-lease.",
    "Only if a conflict needs a product decision you cannot make, report a question for that one.",
    "Do not merge the PR.",
  ].join("\n");
}

/** What to push to the agent: review comments, merge conflicts, or both. */
export interface PrWork {
  comments: boolean;
  conflict: boolean;
}

function workMessage(pr: PrInfo, task: Task, work: PrWork): string {
  const sections: string[] = [];
  if (work.conflict) sections.push(conflictSection(pr, task));
  if (work.comments) sections.push(commentsSection(pr));
  return [sections.join("\n\n"), "", `PR: ${pr.url}`].join("\n");
}

/** Spawn a fresh agent on the task's worktree to handle PR work,
 *  seeded with the handoff document from the original run. */
async function respawnForWork(
  db: Db,
  cfg: Config,
  backend: WorkerBackend,
  task: Task,
  message: string,
  work: PrWork,
): Promise<string | null> {
  // Keep the task's harness: dispatch accepts registry harnesses that are
  // not in cfg.agents, so checking that map would silently fall back.
  const target = task.target || "claude";
  const what = [work.conflict ? "merge conflicts" : "", work.comments ? "review comments" : ""]
    .filter(Boolean)
    .join(" and ");
  const prompt = [
    `Task follow-up: ${what} on your PR for "${taskLabel(task)}".`,
    "",
    task.handoff ? `## Handoff from the previous run\n\n${task.handoff}\n` : "",
    message,
    "",
    "---",
    questionConvention(cfg, task),
  ].join("\n");
  const session = await backend.start({
    taskId: task.id,
    name: `corral-${slugify(taskLabel(task), 20)}-${work.comments ? "review" : "rebase"}`,
    repoPath: task.worktree_path ?? task.repo_path,
    git: task.branch
      ? { branch: task.branch, base: null, existingWorktree: Boolean(task.worktree_path) }
      : null,
    prompt,
    harness: target,
    model: null,
    reasoning: null,
    env: {
      CORRAL_URL: `http://${cfg.host}:${cfg.port}`,
      CORRAL_TOKEN: cfg.token,
      CORRAL_TASK_ID: task.id,
    },
  });
  db.updateTask(task.id, { terminal_address: session.address });
  db.upsertTerminal({
    address: session.address,
    task_id: task.id,
    name: session.name ?? null,
    agent: target,
    last_status: session.status,
    last_turn: session.turn ?? 0,
    updated_ms: Date.now(),
  });
  return session.address;
}

async function deliverWork(
  db: Db,
  cfg: Config,
  backend: WorkerBackend,
  task: Task,
  pr: PrInfo,
  work: PrWork,
): Promise<string | null> {
  const message = workMessage(pr, task, work);
  // Live session? Push into it (its prompt includes the PR loop skill).
  if (task.terminal_address) {
    try {
      const s = await backend.get(task.terminal_address);
      if (s && s.state === "live") {
        await backend.send(task.terminal_address, message);
        return task.terminal_address;
      }
    } catch {
      /* session gone — fall through */
    }
  }
  // Otherwise respawn the agent on the worktree so the loop still runs.
  try {
    return await respawnForWork(db, cfg, backend, task, message, work);
  } catch {
    return null;
  }
}

interface PrMeta {
  /** Thread signature last pushed to the agent. */
  pushed?: string;
  /** Set once conflicts were pushed; cleared when the PR merges cleanly again. */
  conflict?: boolean;
}

function readMeta(raw: string | null): PrMeta {
  try {
    return JSON.parse(raw ?? "{}") as PrMeta;
  } catch {
    return {};
  }
}

function patchMeta(db: Db, taskId: string, patch: PrMeta): void {
  const meta = { ...readMeta(db.getTask(taskId)?.pr_meta ?? null), ...patch };
  if (meta.conflict === false) delete meta.conflict;
  db.updateTask(taskId, { pr_meta: JSON.stringify(meta) });
}

/** Tasks with a delivery underway: blocks a concurrent sync (periodic,
 *  /check-pr, finish event) from respawning a second agent. */
const delivering = new Set<string>();

// ---- sync ----

export interface SyncOptions {
  backend?: WorkerBackend;
  cfg?: Config;
  /** Injected for tests. */
  finder?: (repoPath: string, branch: string) => PrInfo | null;
}

/**
 * Check a task's branch for a PR and reflect it into Corral:
 *  - task.pr_url set (visible on the task row),
 *  - one inbox item (kind "pr") per task — "ready for review" only when the
 *    gate passes; otherwise "needs work" with the reasons,
 *  - unresolved comments are fed to the agent automatically (once per set),
 *  - merge conflicts are fed to the agent as a rebase request (once per episode),
 *  - the item auto-resolves when the PR closes; on merge the task and all
 *    its inbox items are archived (the work is over, the inbox stays clean).
 */
export function syncTaskPr(db: Db, hub: Hub, task: Task, opts: SyncOptions = {}): PrInfo | null {
  const finder = opts.finder ?? findPr;
  const pr = finder(task.repo_path, task.branch ?? "");
  if (!pr) return null;

  if (task.pr_url !== pr.url) {
    db.updateTask(task.id, { pr_url: pr.url });
    db.recordMetric("task.pr_found", task.id, { url: pr.url, state: pr.state });
    hub.broadcast("task.updated", db.getTask(task.id));
  }

  const { ready, reasons } = prReady(pr);
  const existing = db.listItems({ kind: "pr" }).find((i) => i.task_id === task.id) ?? null;
  const shouldResolve = pr.state !== "OPEN";
  const merged = pr.state === "MERGED";
  const doneStatus: Item["status"] = merged ? "archived" : "resolved";

  // The loop: comments and merge conflicts go back to the agent —
  // automatically, once per comment set / conflict episode, in one message.
  const meta = readMeta(task.pr_meta);
  const conflicting = !shouldResolve && pr.mergeable === "CONFLICTING";
  // End the episode only on confirmed mergeability or closure: GitHub reports
  // UNKNOWN while recalculating after a push.
  if (meta.conflict && (shouldResolve || pr.mergeable === "MERGEABLE")) {
    patchMeta(db, task.id, { conflict: false });
  }
  if (!shouldResolve && opts.backend && opts.cfg && !delivering.has(task.id)) {
    const sig = threadSignature(pr);
    const work: PrWork = {
      comments: pr.threads.length > 0 && meta.pushed !== sig,
      conflict: conflicting && !meta.conflict,
    };
    if (work.comments || work.conflict) {
      delivering.add(task.id);
      void deliverWork(db, opts.cfg, opts.backend, task, pr, work)
        .then((address) => {
          if (!address) return; // not delivered: retry on the next sync
          patchMeta(db, task.id, {
            ...(work.comments ? { pushed: sig } : {}),
            ...(work.conflict ? { conflict: true } : {}),
          });
          if (work.comments) {
            db.recordMetric("pr.comments_pushed", task.id, {
              threads: pr.threads.length,
              to: address ?? "none",
            });
          }
          if (work.conflict) {
            db.recordMetric("pr.conflicts_pushed", task.id, { base: pr.base_ref, to: address ?? "none" });
          }
        })
        .catch(() => undefined)
        .finally(() => delivering.delete(task.id));
    }
  }

  const title = shouldResolve
    ? `PR ${pr.state.toLowerCase()}: ${taskLabel(task)}`
    : ready
      ? `PR ready for review: ${taskLabel(task)}`
      : `PR needs work: ${taskLabel(task)}`;

  if (!existing) {
    const item: Item = {
      id: randomUUID(),
      kind: "pr",
      status: shouldResolve ? doneStatus : "open",
      title,
      summary: ready && !shouldResolve ? "ready for review" : reasons.join(", ") || "ready",
      body: prItemBody(pr),
      context: "",
      options: null,
      ready: shouldResolve ? 1 : ready ? 1 : 0,
      source_ref: task.terminal_address,
      task_id: task.id,
      structured: 1,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      resolved_ms: shouldResolve ? Date.now() : null,
      snooze_until_ms: null,
    };
    db.insertItem(item);
    db.recordMetric("item.created", item.id, { kind: "pr", capture: "pr-sync", task_id: task.id, ready: item.ready });
    hub.broadcast("item.created", item);
    if (merged) archiveMergedTask(db, hub, task);
    return pr;
  }

  const patch: Partial<Item> = {};
  if (existing.title !== title) patch.title = title;
  // Follow respawns so inbox replies reach the current session.
  const address = db.getTask(task.id)?.terminal_address ?? null;
  if (address && existing.source_ref !== address) patch.source_ref = address;
  const body = prItemBody(pr);
  if (existing.body !== body) patch.body = body;
  const summary = ready && !shouldResolve ? "ready for review" : reasons.join(", ") || "ready";
  if (existing.summary !== summary) patch.summary = summary;
  const readyFlag = shouldResolve ? 1 : ready ? 1 : 0;
  if (existing.ready !== readyFlag) patch.ready = readyFlag;
  if (shouldResolve && existing.status !== doneStatus && existing.status !== "archived") {
    patch.status = doneStatus;
    patch.resolved_ms = existing.resolved_ms ?? Date.now();
  } else if (!shouldResolve && existing.status === "resolved") {
    // PR reopened (e.g. new comments after merge-back) — surface again.
    patch.status = "open";
    patch.resolved_ms = null;
  }
  if (Object.keys(patch).length > 0) {
    db.updateItem(existing.id, patch);
    hub.broadcast("item.updated", db.getItem(existing.id));
    if (patch.ready === 1) {
      db.recordMetric("item.ready_for_review", existing.id, { task_id: task.id });
    }
  }
  if (merged) archiveMergedTask(db, hub, task);
  return pr;
}

/** Merged PR = the task is over: archive the task and every inbox item tied to it. */
function archiveMergedTask(db: Db, hub: Hub, task: Task): void {
  const now = Date.now();
  for (const item of db.listItems()) {
    if (item.task_id !== task.id || item.status === "archived") continue;
    db.updateItem(item.id, { status: "archived", resolved_ms: item.resolved_ms ?? now });
    hub.broadcast("item.updated", db.getItem(item.id));
  }
  const current = db.getTask(task.id);
  if (current && current.status !== "archived") {
    db.updateTask(task.id, { status: "archived" });
    db.recordMetric("task.archived", task.id, { how: "pr-merged" });
    hub.broadcast("task.updated", db.getTask(task.id));
  }
}

/** Tasks whose branch may have a PR: dispatched/done, with a repo and branch. */
export function prCandidateTasks(db: Db): Task[] {
  return db
    .listTasks()
    .filter((t) => (t.status === "dispatched" || t.status === "done") && t.branch && t.repo_path);
}

let lastSyncAll = 0;

/** Sync every candidate task's PR (or only those with a known PR, which is
 *  all a merge check needs). Throttled so opening the inbox repeatedly
 *  does not hammer gh/glab (each call blocks for up to 20s). */
export function syncAllPrs(
  db: Db,
  hub: Hub,
  opts: SyncOptions & { knownPrsOnly?: boolean } = {},
  minIntervalMs = 30_000,
): boolean {
  const now = Date.now();
  if (now - lastSyncAll < minIntervalMs) return false;
  lastSyncAll = now;
  const tasks = prCandidateTasks(db).filter((t) => !opts.knownPrsOnly || t.pr_url);
  for (const task of tasks) {
    try {
      syncTaskPr(db, hub, task, opts);
    } catch {
      /* best effort */
    }
  }
  return true;
}
