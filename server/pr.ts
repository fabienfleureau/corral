// PR/MR readiness: Corral verifies — from the platform APIs — that a task's PR
// is actually ready for human review (exists, threads resolved, checks green,
// mergeable) before it is shown as such. And when review comments or merge
// conflicts appear, Corral feeds them back to the task's agent automatically (the PR loop in
// skills/pr-loop.md) so the human only ever sees "ready for review".

import { mapLimit, runAsync } from "./exec.ts";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { archiveEpicLaunchItems } from "./epic-graph.ts";
import type { Db } from "./db.ts";
import type { WorkerBackend } from "./worker.ts";
import type { Hub } from "./capture.ts";
import type { Item, MergeReadiness, Task, TaskOutcome } from "./types.ts";
import { DATA_NOT_INSTRUCTIONS, questionConvention, slugify } from "./dispatch.ts";
import { JiraClient } from "./jira.ts";
import { syncJiraStage, type JiraStage, type JiraTransitionGateway } from "./jira-status.ts";
import { logTaskEvent, promptData } from "./task-events.ts";
import { cleanupFinishedTask, cleanupTerminalWorktrees } from "./worktree-cleanup.ts";
import { classifyPrTriage, formatTriageSummary, type PrTriage } from "./pr-triage.ts";

export interface PrThread {
  /** Stable id (GraphQL thread id, or GitLab discussion id) for dedupe. */
  id: string;
  author: string;
  body: string;
}

export interface PrCheckFailure {
  name: string;
  conclusion: string;
  url?: string | null;
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
  /** Repo-relative paths changed by the PR, when available from the platform. */
  changed_file_paths?: string[];
  /** Head commit SHA, when available from the platform (scopes CI auto-fix retries). */
  head_sha?: string | null;
  /** MERGEABLE | CONFLICTING | UNKNOWN (null when the platform says nothing) */
  mergeable: string | null;
  /** Branch the PR merges into (rebase target when conflicting). */
  base_ref: string | null;
  review_decision: string | null;
  /** Current human approvals, or null when unavailable. */
  human_approvals?: string[] | null;
  checks: { total: number; failed: number; pending: boolean };
  /** Individual failing checks, when available from the platform. */
  failed_checks?: PrCheckFailure[];
  /** Unresolved review threads — the "comments to manage". */
  threads: PrThread[];
  /** Merge time reported by the platform (ms), when merged and known. */
  merged_ms?: number | null;
  /** False when thread data could not be fetched: readiness stays pending. */
  threads_known?: boolean;
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
  if (pr.threads_known === false) reasons.push("review comments unavailable");
  if (pr.checks.pending) reasons.push("checks still running");
  if (pr.checks.failed > 0) reasons.push(`${pr.checks.failed} failing check${pr.checks.failed === 1 ? "" : "s"}`);
  if (pr.mergeable === "CONFLICTING") reasons.push("merge conflicts");
  else if (pr.state === "OPEN" && pr.mergeable !== "MERGEABLE") reasons.push("mergeability unknown");
  if (pr.review_decision === "CHANGES_REQUESTED") reasons.push("changes requested");
  return { ready: reasons.length === 0, reasons };
}

/** Where a ready PR sits in Corral's own vocabulary: passing the gate makes it
 *  "ready for review"; only a human approval makes it "ready to merge". The
 *  inbox label and the Jira sync both read this, so the ticket never claims a
 *  merge readiness Corral has not recorded. Unknown approvals (null) count as
 *  none. */
export function prReviewLabel(pr: PrInfo): "ready for review" | "ready to merge" {
  return pr.human_approvals?.length ? "ready to merge" : "ready for review";
}

export function prItemBody(pr: PrInfo, triage?: PrTriage | null): string {
  const lines: string[] = [];
  const desc = pr.description.trim();
  if (desc) lines.push(desc.slice(0, 2000), "");
  lines.push(
    "| | |",
    "|---|---|",
    `| Files changed | ${pr.changed_files} |`,
    `| Lines | +${pr.additions} / -${pr.deletions} |`,
    `| Review comments | ${pr.threads.length} unresolved |`,
    `| Human approvals | ${pr.human_approvals == null ? "unavailable" : pr.human_approvals.length ? pr.human_approvals.map((name) => name.replace(/[|\\]/g, "\\$&")).join(", ") : "none"} |`,
    `| Checks | ${pr.checks.total === 0 ? "none configured" : pr.checks.pending ? "running" : pr.checks.failed > 0 ? `${pr.checks.failed} failing` : "green"} |`,
    `| Mergeable | ${pr.mergeable ? pr.mergeable.toLowerCase() : "unknown"} |`,
    ...(triage ? [`| Review triage | ${formatTriageSummary(triage).replace(/[|\\]/g, "\\$&")} |`] : []),
    "",
    `PR: ${pr.url}`,
  );
  return lines.join("\n");
}

// ---- discovery ----

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return runAsync(cmd, args, { cwd, timeout: 20_000 });
}

async function repoSlug(repoPath: string): Promise<string | null> {
  try {
    const url = await run("git", ["remote", "get-url", "origin"], repoPath);
    const m = url.match(/[:/]([^:/]+)\/([^:/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/** ISO timestamp from gh/glab -> ms, or null when absent or unparsable. */
function platformTime(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function summarizeChecks(rollup: unknown[]): { checks: PrInfo["checks"]; failedChecks: PrCheckFailure[] } {
  let failed = 0;
  let pending = 0;
  const failedChecks: PrCheckFailure[] = [];
  for (const raw of rollup) {
    const c = raw as Record<string, unknown>;
    const state = String(c.conclusion ?? c.state ?? "").toUpperCase();
    const status = String(c.status ?? "").toUpperCase();
    if (state === "SUCCESS" || state === "NEUTRAL" || state === "SKIPPED") continue;
    if (state === "" || state === "PENDING" || state === "EXPECTED" || state === "QUEUED" || status === "IN_PROGRESS" || status === "QUEUED") {
      pending++;
    } else {
      failed++;
      const name = String(c.name ?? c.context ?? "check").trim() || "check";
      const url = typeof c.detailsUrl === "string" ? c.detailsUrl : typeof c.targetUrl === "string" ? c.targetUrl : null;
      failedChecks.push({ name: name.slice(0, 200), conclusion: state.toLowerCase(), url });
    }
  }
  return { checks: { total: rollup.length, failed, pending: pending > 0 }, failedChecks };
}

/** GitLab head pipeline status -> checks summary (no pipeline = no checks). */
export function gitlabPipelineChecks(status: string | null | undefined): PrInfo["checks"] {
  if (!status) return { total: 0, failed: 0, pending: false };
  if (status === "success" || status === "skipped" || status === "manual") return { total: 1, failed: 0, pending: false };
  if (status === "failed" || status === "canceled") return { total: 1, failed: 1, pending: false };
  return { total: 1, failed: 0, pending: true }; // created, pending, running, preparing, scheduled, …
}

async function findPrGitHub(repoPath: string, branch: string): Promise<PrInfo | null> {
  const out = await run(
    "gh",
    [
      "pr", "view", branch,
      "--json", "url,title,state,number,body,additions,deletions,changedFiles,files,headRefOid,mergedAt,mergeable,baseRefName,reviewDecision,statusCheckRollup",
    ],
    repoPath,
  );
  const d = JSON.parse(out) as Record<string, unknown>;
  const state = String(d.state).toUpperCase();
  // Merged/closed PRs are terminal: skip reviews and GraphQL thread fetches.
  const slug = state === "OPEN" ? await repoSlug(repoPath) : null;
  let humanApprovals: string[] | null = null;
  if (slug) {
    try {
      const pages = JSON.parse(await run("gh", ["api", `repos/${slug}/pulls/${Number(d.number)}/reviews`, "--paginate", "--slurp"], repoPath)) as { state?: string; user?: { login?: string; type?: string } }[][];
      const latest = new Map<string, string>();
      for (const review of pages.flat()) {
        const user = review.user;
        if (!user?.login || user.type !== "User" || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state ?? "")) continue;
        latest.set(user.login, review.state!);
      }
      humanApprovals = [...latest].filter(([, state]) => state === "APPROVED").map(([login]) => login);
    } catch { /* approval data unavailable */ }
  }
  const threads: PrThread[] = [];
  let threadsKnown = false;
  if (slug) {
    // reviewThreads (unresolved) is only on GraphQL.
    const [owner, name] = slug.split("/");
    const query =
      `query{repository(owner:"${owner}",name:"${name}"){pullRequest(number:${Number(d.number)}){` +
      `reviewThreads(first:50){nodes{id isResolved comments(first:10){nodes{author{login} body}}}}}}}`;
    try {
      const gql = JSON.parse(await run("gh", ["api", "graphql", "-f", `query=${query}`], repoPath)) as {
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown[] } } } };
      };
      const nodes = gql.data?.repository?.pullRequest?.reviewThreads?.nodes;
      if (!nodes) throw new Error("no thread data");
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
      threadsKnown = true;
    } catch {
      /* GraphQL unavailable: readiness stays pending (threads_known=false) */
    }
  }
  const { checks, failedChecks } = summarizeChecks((d.statusCheckRollup as unknown[]) ?? []);
  const changedFilePaths = Array.isArray(d.files)
    ? (d.files as { path?: unknown }[]).map((f) => (typeof f?.path === "string" ? f.path : "")).filter(Boolean)
    : undefined;
  return {
    url: String(d.url),
    title: String(d.title),
    state: String(d.state).toUpperCase(),
    number: Number(d.number),
    description: String(d.body ?? ""),
    additions: Number(d.additions ?? 0),
    deletions: Number(d.deletions ?? 0),
    changed_files: Number(d.changedFiles ?? 0),
    ...(changedFilePaths ? { changed_file_paths: changedFilePaths } : {}),
    head_sha: typeof d.headRefOid === "string" && d.headRefOid ? d.headRefOid : null,
    mergeable: d.mergeable ? String(d.mergeable).toUpperCase() : null,
    base_ref: d.baseRefName ? String(d.baseRefName) : null,
    review_decision: d.reviewDecision ? String(d.reviewDecision).toUpperCase() : null,
    human_approvals: humanApprovals,
    checks,
    ...(failedChecks.length > 0 ? { failed_checks: failedChecks } : {}),
    threads,
    threads_known: threadsKnown,
    merged_ms: platformTime(d.mergedAt),
  };
}

const GITLAB_MR_URL = /^(https?:\/\/.+?)(?:\/-)?\/merge_requests\/(\d+)(?:[/?#].*)?$/;

function gitlabHost(repoUrl: string): string | null {
  try {
    return new URL(repoUrl).host || null;
  } catch {
    return null;
  }
}

async function findPrGitLab(repoPath: string, branch: string): Promise<PrInfo | null> {
  const match = branch.match(GITLAB_MR_URL);
  const out = match
    ? await run("glab", ["mr", "view", match[2], "--repo", match[1], "--output", "json"], repoPath)
    : await run("glab", ["mr", "list", "--source-branch", branch, "--all", "--output", "json"], repoPath);
  const parsed = JSON.parse(out) as Record<string, unknown> | Record<string, unknown>[];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) return null;
  const mr = list[0];
  const iid = Number(mr.iid ?? 0);
  const rawState = String(mr.state ?? "opened").toUpperCase();
  const state = rawState === "OPENED" ? "OPEN" : rawState;
  const host = match ? gitlabHost(match[1]) : null;
  // The MR may live in another project than the task repo (`:id` resolves from
  // the cwd's remote): address it by its own project_id when available.
  const project = Number(mr.project_id) > 0 ? String(Number(mr.project_id)) : ":id";
  const api = (path: string) =>
    run("glab", ["api", ...(host ? ["--hostname", host] : []), `projects/${project}/merge_requests/${iid}${path}`], repoPath);

  // Merged/closed MRs are terminal: skip the four extra API calls so sweeps
  // stay fast and don't burn GitLab rate limits on non-open MRs.
  const [full, approvals, changes, discussions] = state === "OPEN"
    ? await Promise.all([
        api("").then((s) => JSON.parse(s) as { description?: string; has_conflicts?: boolean; sha?: string; head_pipeline?: { status?: string; sha?: string; web_url?: string } | null }).catch(() => null),
        api("/approvals").then((s) => JSON.parse(s) as { approved_by?: { user?: { username?: string; bot?: boolean } }[] }).catch(() => null),
        api("/changes").then((s) => JSON.parse(s) as { changes?: { diff?: string; new_path?: string; old_path?: string }[] }).catch(() => null),
        api("/discussions?per_page=100")
          .then((s) => JSON.parse(s) as {
            id?: string;
            notes?: { resolvable?: boolean; resolved?: boolean; author?: { username?: string }; body?: string }[];
          }[])
          .catch(() => null),
      ])
    : [null, null, null, null];

  let additions = 0;
  let deletions = 0;
  const diff = changes?.changes ?? [];
  const changedFilePaths: string[] = [];
  for (const c of diff) {
    const filePath = c.new_path || c.old_path;
    if (filePath) changedFilePaths.push(filePath);
    for (const line of (c.diff ?? "").split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }
  const threads: PrThread[] = [];
  for (const d of discussions ?? []) {
    const note = d.notes?.[0];
    if (!note?.resolvable || note.resolved) continue;
    threads.push({
      id: String(d.id ?? randomUUID()),
      author: String(note.author?.username ?? "reviewer"),
      body: String(note.body ?? "").slice(0, 2000),
    });
  }
  const pipelineStatus = full ? full.head_pipeline?.status : (mr.head_pipeline as { status?: string } | null | undefined)?.status;
  // Pipeline unknown on an open MR (MR fetch failed) = pending, never "no checks".
  const checks = state !== "OPEN"
    ? gitlabPipelineChecks(pipelineStatus)
    : full
      ? gitlabPipelineChecks(full.head_pipeline?.status)
      : { total: 1, failed: 0, pending: true };
  const headSha = full?.head_pipeline?.sha ?? full?.sha ?? (typeof mr.sha === "string" ? mr.sha : null);
  const failedChecks: PrCheckFailure[] = checks.failed > 0
    ? [{ name: "GitLab pipeline", conclusion: String(pipelineStatus ?? "failed").toLowerCase(), url: full?.head_pipeline?.web_url ?? null }]
    : [];
  return {
    url: String(mr.web_url ?? ""),
    title: String(mr.title ?? ""),
    state,
    number: iid,
    description: String(mr.description ?? "") || full?.description || "",
    additions,
    deletions,
    changed_files: diff.length,
    ...(changedFilePaths.length > 0 ? { changed_file_paths: changedFilePaths } : {}),
    head_sha: headSha,
    mergeable: (full?.has_conflicts ?? mr.has_conflicts) === true ? "CONFLICTING" : (full?.has_conflicts ?? mr.has_conflicts) === false ? "MERGEABLE" : null,
    base_ref: mr.target_branch ? String(mr.target_branch) : null,
    review_decision: null,
    human_approvals: approvals?.approved_by ? approvals.approved_by.flatMap(({ user }) => user?.username && !user.bot && !/^gitlab[ _-]*duo$/i.test(user.username) ? [user.username] : []) : null,
    checks,
    ...(failedChecks.length > 0 ? { failed_checks: failedChecks } : {}),
    threads,
    threads_known: state !== "OPEN" || discussions !== null,
    merged_ms: platformTime(mr.merged_at),
  };
}

export async function findPr(repoPath: string, branch: string): Promise<PrInfo | null> {
  // A reported PR URL is enough on its own: gh/glab can look it up without a
  // local checkout. A bare branch still needs a repo to resolve it against.
  const urlRef = /^https?:\/\//.test(branch);
  if (!branch || (!repoPath && !urlRef)) return null;
  const gitlabUrl = GITLAB_MR_URL.test(branch);
  const lookup = async (cwd: string): Promise<PrInfo | null> => {
    if (!gitlabUrl) {
      try {
        return await findPrGitHub(cwd, branch);
      } catch {
        /* not GitHub or gh missing — try GitLab */
      }
    }
    try {
      return await findPrGitLab(cwd, branch);
    } catch {
      return null;
    }
  };
  const found = await lookup(repoPath);
  if (found || !urlRef || !repoPath) return found;
  // A checkout that was moved or removed makes both CLIs fail before they can
  // read the URL. A URL needs no local repo, so retry from the process cwd.
  return lookup("");
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
    "for each comment: fix the code, or reply on the thread saying why not (one or two lines),",
    "then resolve the threads you fixed — Corral counts your reply as an answer, so",
    "leave a thread you only replied to unresolved:",
    "  gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:\"<thread id>\"}){thread{isResolved}}}'",
    "run your tests, commit and push. Do not ask for permission. Do not merge the PR.",
    "",
    // Thread bodies are the reviewer's (or anyone's) words, verbatim.
    DATA_NOT_INSTRUCTIONS,
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

/** Max automatic CI-failure hand-offs for the same head commit SHA before
 *  stopping to avoid infinite token burn on flaky or external CI failures. */
export const MAX_CI_FIX_ATTEMPTS = 2;

function checksSignature(pr: PrInfo): string {
  const sha = pr.head_sha ?? "";
  const items = pr.failed_checks?.length
    ? pr.failed_checks.map((c) => `${c.name}:${c.conclusion}`).sort().join(",")
    : `failed:${pr.checks.failed}`;
  return `${sha}|${items}`;
}

function checksSection(pr: PrInfo): string {
  const list = pr.failed_checks?.length
    ? pr.failed_checks.map((c, i) => `[${i + 1}] ${c.name} (${c.conclusion})${c.url ? ` — ${c.url}` : ""}`)
    : [`[1] ${pr.checks.failed} failing CI check${pr.checks.failed === 1 ? "" : "s"}`];
  return [
    "PR failing checks need handling — this is the PR loop, not a question:",
    "inspect the failing check(s) (e.g. `gh pr checks` / `gh run view --log-failed` or `glab ci trace`),",
    "reproduce locally, fix the root cause, run your tests, commit and push.",
    "Do not ask for permission. Do not merge the PR.",
    "Only if the failure is external/flaky infrastructure you cannot fix or needs a decision, report a question.",
    "",
    // Check names, URLs and CI logs come from external runs/third-party apps.
    DATA_NOT_INSTRUCTIONS,
    "",
    ...list,
  ].join("\n");
}

/** What to push to the agent: review comments, merge conflicts, failing checks, or any combination. */
export interface PrWork {
  comments: boolean;
  conflict: boolean;
  checks?: boolean;
}

/** Work handed to the agent by a sync (reported by a forced refresh). */
export interface PrDelivery extends PrWork {
  /** Session the work went to, or null when the hand-off failed. */
  address: string | null;
}

function workMessage(pr: PrInfo, task: Task, work: PrWork): string {
  const sections: string[] = [];
  if (work.conflict) sections.push(conflictSection(pr, task));
  if (work.comments) sections.push(commentsSection(pr));
  if (work.checks) sections.push(checksSection(pr));
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
  const what = [
    work.conflict ? "merge conflicts" : "",
    work.comments ? "review comments" : "",
    work.checks ? "failing checks" : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const prompt = [
    `Task follow-up: ${what} on your PR for "${task.title}".`,
    "",
    task.handoff ? `## Handoff from the previous run\n\n${task.handoff}\n` : "",
    message,
    "",
    "---",
    questionConvention(cfg, task),
  ].join("\n");
  const suffix = work.comments ? "review" : work.conflict ? "rebase" : "ci";
  const session = await backend.start({
    taskId: task.id,
    project: task.repo_path ? db.getRepoByPath(task.repo_path)?.name ?? task.repo_path : null,
    name: `corral-${slugify(task.title, 20)}-${suffix}`,
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

/** Last observed PR/MR state. Persisted so later analyses can explain why the
 *  readiness gate kept failing (checks, threads, mergeability) instead of only
 *  seeing repeated "ready for review" events. */
export interface PrSnapshot {
  url: string;
  state: string;
  mergeable: string | null;
  checks: { total: number; failed: number; pending: boolean };
  threads: { unresolved: number; ids: string[]; known: boolean };
  ready: boolean;
  reasons: string[];
  review_decision: string | null;
  base_ref: string | null;
  triage?: PrTriage;
  checked_ms: number;
}

interface PrMeta {
  /** Thread signature last pushed to the agent. */
  pushed?: string;
  /** Set once conflicts were pushed; cleared when the PR merges cleanly again. */
  conflict?: boolean;
  /** Failing-check signature last pushed to the agent; cleared when checks pass. */
  checks_pushed?: string;
  /** Count of automatic CI-failure hand-offs for the current head commit SHA. */
  checks_attempts?: { sha: string; count: number } | null;
  /** Last observed state; see PrSnapshot. */
  pr?: PrSnapshot;
  /** When the agent reported done while the task stays open for its PR (ADR 0022). */
  done_reported_ms?: number;
}

function readMeta(raw: string | null): PrMeta {
  try {
    return JSON.parse(raw ?? "{}") as PrMeta;
  } catch {
    return {};
  }
}

/** Tasks whose PR the loop follows: their own PR completes them. Review,
 *  spec, analysis, ops and grill tasks have no PR of their own. */
export function isPrSyncedTask(task: Pick<Task, "kind">): boolean {
  return task.kind !== "review" && task.kind !== "spec" && task.kind !== "analysis" && task.kind !== "ops" && task.kind !== "grill";
}

/** The agent reported done on this task while its PR may still be open. */
export function doneReported(task: Pick<Task, "pr_meta">): boolean {
  return readMeta(task.pr_meta).done_reported_ms !== undefined;
}

/** Remember a done report: the task stays in its status until its PR merges
 *  or closes (ADR 0022). Not task activity, so updated_ms is kept. */
export function noteDoneReport(db: Db, taskId: string): void {
  patchMeta(db, taskId, { done_reported_ms: Date.now() }, false);
}

/** Mark a task done with how it ended. A task already done or archived keeps
 *  its status but still records the outcome its PR settled. */
export function completeTask(db: Db, hub: Hub, taskId: string, outcome: TaskOutcome, how: string, message: string, data: Record<string, unknown> = {}): void {
  const current = db.getTask(taskId);
  if (!current) return;
  const finish = current.status !== "done" && current.status !== "archived";
  if (!finish && current.outcome === outcome) return;
  db.updateTask(taskId, finish ? { status: "done", outcome } : { outcome }, finish);
  if (finish) {
    db.recordMetric("task.done", taskId, { how, outcome });
    logTaskEvent(db, taskId, "pr", message, data);
  }
  hub.broadcast("task.updated", db.getTask(taskId));
}

function patchMeta(db: Db, taskId: string, patch: PrMeta, touch = true): void {
  const meta = { ...readMeta(db.getTask(taskId)?.pr_meta ?? null), ...patch };
  if (meta.conflict === false) delete meta.conflict;
  if (meta.checks_pushed === "") delete meta.checks_pushed;
  if (meta.checks_attempts === null) delete meta.checks_attempts;
  db.updateTask(taskId, { pr_meta: JSON.stringify(meta) }, touch);
}

function snapshotPr(pr: PrInfo, ready: boolean, reasons: string[], triage: PrTriage, checkedMs: number): PrSnapshot {
  return {
    url: pr.url,
    state: pr.state,
    mergeable: pr.mergeable,
    checks: pr.checks,
    threads: { unresolved: pr.threads.length, ids: pr.threads.map((t) => t.id).slice(0, 50), known: pr.threads_known !== false },
    ready,
    reasons,
    review_decision: pr.review_decision,
    base_ref: pr.base_ref,
    triage,
    checked_ms: checkedMs,
  };
}

/** The agent has this task's PR item in flight: the item waits under
 *  "In progress" instead of asking the human for something nobody can act on
 *  yet. Cleared when the run ends or the gate passes. */
function setItemHandling(db: Db, hub: Hub, taskId: string, handling: boolean, opts: { unsnooze?: boolean } = {}): void {
  const item = db.listItems({ kind: "pr" }).find((i) => i.task_id === taskId && i.status !== "archived");
  const value = handling ? 1 : 0;
  if (!item) return;
  const patch: Partial<Item> = {};
  if ((item.handling ?? 0) !== value) patch.handling = value;
  if (handling && opts.unsnooze && item.snooze_until_ms !== null) patch.snooze_until_ms = null;
  if (Object.keys(patch).length === 0) return;
  db.updateItem(item.id, patch);
  hub.broadcast("item.updated", db.getItem(item.id));
}

/** The run ended (finished, idle, or reported done): the PR item goes back to
 *  the open inbox while the gate still fails. */
export function clearItemHandling(db: Db, hub: Hub, taskId: string): void {
  setItemHandling(db, hub, taskId, false);
}

/** Tasks with a delivery underway: blocks a concurrent sync (periodic,
 *  /check-pr, finish event) from respawning a second agent. */
const delivering = new Set<string>();

// ---- sync ----

export interface SyncOptions {
  backend?: WorkerBackend;
  cfg?: Config;
  /** Jira status sync gateway (default: built from cfg.jira, null = disabled). */
  jira?: JiraTransitionGateway | null;
  /** Injected for tests. */
  finder?: (repoPath: string, branch: string) => PrInfo | null | Promise<PrInfo | null>;
  /** A human asked for this check (inbox "force refresh"): re-hand the PR's
   *  review comments and merge conflicts even when the loop already pushed
   *  them, and wait for the hand-off so the caller can report it. */
  force?: boolean;
  /** Called when the sync handed work to the agent. */
  onDelivered?: (delivery: PrDelivery) => void;
}

/**
 * Check a task's branch for a PR and reflect it into Corral:
 *  - task.pr_url set (visible on the task row),
 *  - one inbox item (kind "pr") per task — "ready for review" only when the
 *    gate passes; otherwise "needs work" with the reasons,
 *  - unresolved comments are fed to the agent automatically (once per set),
 *  - merge conflicts are fed to the agent as a rebase request (once per episode),
 *  - the item resolves on close; a merge completes the task and archives its items.
 */
export async function syncTaskPr(db: Db, hub: Hub, staleTask: Task, opts: SyncOptions = {}): Promise<PrInfo | null> {
  // A review task's pr_url is someone else's MR: its threads are not work for
  // the agent, and its merge does not complete the review.
  if (!isPrSyncedTask(staleTask)) return null;
  const finder = opts.finder ?? findPr;
  const item = db.listItems({ kind: "pr" }).find((i) => i.task_id === staleTask.id && i.status !== "archived");
  const reportedUrl = item?.body.match(/https?:\/\/[^\s<>)]+(?:\/pull\/|(?:\/-)?\/merge_requests\/)\d+/)?.[0];
  const ref = staleTask.pr_url || reportedUrl || staleTask.branch || "";
  const pr = await finder(staleTask.repo_path, ref);
  if (!pr) return null;
  // The platform calls take seconds: work from the task as it is now.
  const task = db.getTask(staleTask.id) ?? staleTask;

  if (task.pr_url !== pr.url) {
    db.updateTask(task.id, { pr_url: pr.url });
    db.recordMetric("task.pr_found", task.id, { url: pr.url, state: pr.state });
    hub.broadcast("task.updated", db.getTask(task.id));
  }

  const { ready, reasons } = prReady(pr);
  // A live PR item can belong to a task whose session was archived or which
  // left the queue. Its status still needs following, but no agent should be
  // respawned for work on a task nobody is running.
  const agentTask = task.status === "dispatched" || task.status === "done";
  const taskPrItems = db.listItems({ kind: "pr" }).filter((i) => i.task_id === task.id);
  const existing = taskPrItems.find((i) => i.status !== "archived") ?? taskPrItems[0] ?? null;
  const shouldResolve = pr.state !== "OPEN";
  const merged = pr.state === "MERGED";
  syncJiraPrStage(db, hub, task, pr, ready, merged, opts);
  // Before the snapshot below replaces it: the last state seen while open.
  if (merged) recordMerge(db, hub, task, pr, readMeta(task.pr_meta).pr ?? null);
  if (merged && task.terminal_address && opts.backend?.archive) {
    await opts.backend.archive(task.terminal_address).catch(() => undefined);
  }
  const doneStatus: Item["status"] = "resolved";

  // The loop: comments, merge conflicts, and failing CI checks go back to the
  // agent — automatically, once per comment set / conflict episode / check
  // failure signature (bounded per head SHA), in one message.
  const meta = readMeta(task.pr_meta);
  const triage = classifyPrTriage(pr, { repoPath: task.repo_path });
  const triageJson = JSON.stringify(triage);
  // Persist what the gate saw, without bumping updated_ms: this is evidence
  // for the activity digest, not task activity.
  const snapshot = snapshotPr(pr, ready, reasons, triage, Date.now());
  if (JSON.stringify(meta.pr) !== JSON.stringify(snapshot)) patchMeta(db, task.id, { pr: snapshot }, false);
  const conflicting = !shouldResolve && pr.mergeable === "CONFLICTING";
  // End the episode only on confirmed mergeability or closure: GitHub reports
  // UNKNOWN while recalculating after a push.
  if (meta.conflict && (shouldResolve || pr.mergeable === "MERGEABLE")) {
    patchMeta(db, task.id, { conflict: false });
  }
  if ((meta.checks_pushed || meta.checks_attempts) && (shouldResolve || (pr.checks.failed === 0 && !pr.checks.pending))) {
    patchMeta(db, task.id, { checks_pushed: "", checks_attempts: null });
  }
  if (!shouldResolve && agentTask && opts.backend && opts.cfg && !delivering.has(task.id)) {
    const sig = threadSignature(pr);
    const checkSig = checksSignature(pr);
    const shaKey = pr.head_sha ?? "";
    const prevAttempts = meta.checks_attempts?.sha === shaKey ? meta.checks_attempts.count : 0;
    const checksFailing = pr.checks.failed > 0 && (opts.force === true || !pr.checks.pending);
    const canAutoRetryChecks = meta.checks_pushed !== checkSig && prevAttempts < MAX_CI_FIX_ATTEMPTS;
    const work: PrWork = {
      // A forced refresh re-hands work the loop already pushed: the human asked
      // because the last hand-off did not land (failed run, unresolved thread).
      comments: pr.threads.length > 0 && (opts.force === true || meta.pushed !== sig),
      conflict: conflicting && (opts.force === true || !meta.conflict),
      checks: checksFailing && (opts.force === true || canAutoRetryChecks),
    };
    if (work.comments || work.conflict || work.checks) {
      delivering.add(task.id);
      const delivery = deliverWork(db, opts.cfg, opts.backend, task, pr, work)
        .then((address) => {
          opts.onDelivered?.({
            address,
            comments: work.comments,
            conflict: work.conflict,
            ...(work.checks ? { checks: true } : {}),
          });
          if (!address) return; // not delivered: retry on the next sync
          // The agent owns the item now: it shows under "In progress".
          setItemHandling(db, hub, task.id, true, { unsnooze: opts.force === true });
          patchMeta(db, task.id, {
            ...(work.comments ? { pushed: sig } : {}),
            ...(work.conflict ? { conflict: true } : {}),
            ...(work.checks
              ? { checks_pushed: checkSig, checks_attempts: { sha: shaKey, count: prevAttempts + 1 } }
              : {}),
          });
          // The work handed to the agent is a prompt like any other: the
          // history shows what was sent and to which session.
          if (work.comments) {
            logTaskEvent(db, task.id, "prompt", `Review comments sent to the agent (${pr.threads.length})`, promptData(workMessage(pr, task, { comments: true, conflict: false }), {
              source: "pr-comments",
              threads: pr.threads.length,
              session: address,
              pr: pr.url,
            }));
          }
          if (work.conflict) {
            logTaskEvent(db, task.id, "prompt", `Merge conflicts sent to the agent (base ${pr.base_ref})`, promptData(workMessage(pr, task, { comments: false, conflict: true }), {
              source: "pr-conflict",
              base: pr.base_ref,
              session: address,
              pr: pr.url,
            }));
          }
          if (work.checks) {
            logTaskEvent(db, task.id, "prompt", `Failing CI checks sent to the agent (${pr.checks.failed})`, promptData(workMessage(pr, task, { comments: false, conflict: false, checks: true }), {
              source: "pr-checks",
              failed: pr.checks.failed,
              checks: (pr.failed_checks ?? []).map((c) => c.name),
              session: address,
              pr: pr.url,
            }));
          }
          if (work.comments) {
            db.recordMetric("pr.comments_pushed", task.id, {
              threads: pr.threads.length,
              to: address ?? "none",
            });
          }
          if (work.conflict) {
            db.recordMetric("pr.conflicts_pushed", task.id, { base: pr.base_ref, to: address ?? "none" });
          }
          if (work.checks) {
            db.recordMetric("pr.checks_pushed", task.id, { failed: pr.checks.failed, to: address ?? "none" });
          }
        })
        .catch(() => undefined)
        .finally(() => delivering.delete(task.id));
      // A forced refresh is an explicit human action: answer once the hand-off
      // happened (or failed) instead of leaving the inbox guessing.
      if (opts.force) await delivery;
      else void delivery;
    }
  }

  const readyStatus = prReviewLabel(pr);
  const title = shouldResolve
    ? `PR ${pr.state.toLowerCase()}: ${pr.title}`
    : ready
      ? `PR ${readyStatus}: ${pr.title}`
      : `PR needs work: ${pr.title}`;

  if (!existing) {
    const item: Item = {
      id: randomUUID(),
      kind: "pr",
      status: shouldResolve ? doneStatus : "open",
      title,
      summary: ready && !shouldResolve ? readyStatus : reasons.join(", ") || "ready",
      body: prItemBody(pr, triage),
      context: "",
      options: null,
      ready: shouldResolve ? 1 : ready ? 1 : 0,
      handling: 0,
      triage: triageJson,
      source_ref: task.terminal_address,
      task_id: task.id,
      structured: 1,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      resolved_ms: shouldResolve ? Date.now() : null,
      snooze_until_ms: null,
    };
    db.insertItem(item);
    db.recordMetric("item.created", item.id, { kind: "pr", capture: "pr-sync", task_id: task.id, ready: item.ready, triage: triage.tier });
    if (ready && !shouldResolve) {
      logTaskEvent(db, task.id, "pr", `PR ${readyStatus}`, { pr: pr.url, checks: pr.checks, threads: pr.threads.length, triage });
    }
    hub.broadcast("item.created", item);
    if (merged) await resolveMergedTask(db, hub, task, opts.backend);
    else if (pr.state === "CLOSED") resolveClosedTask(db, hub, task);
    return pr;
  }

  const patch: Partial<Item> = {};
  if (existing.title !== title) patch.title = title;
  // Follow respawns so inbox replies reach the current session.
  const address = db.getTask(task.id)?.terminal_address ?? null;
  if (address && existing.source_ref !== address) patch.source_ref = address;
  const body = prItemBody(pr, triage);
  if (existing.body !== body) patch.body = body;
  if (existing.triage !== triageJson) patch.triage = triageJson;
  const summary = ready && !shouldResolve ? readyStatus : reasons.join(", ") || "ready";
  if (existing.summary !== summary) patch.summary = summary;
  const readyFlag = shouldResolve ? 1 : ready ? 1 : 0;
  if (existing.ready !== readyFlag) patch.ready = readyFlag;
  // Keeping the work is up to the run: this only ends the handling phase when
  // the gate passes or the PR closes (capture clears it when a run ends).
  const handling = shouldResolve || ready ? 0 : existing.handling ?? 0;
  if ((existing.handling ?? 0) !== handling) patch.handling = handling;
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
      logTaskEvent(db, task.id, "pr", `PR ${readyStatus}`, { pr: pr.url, checks: pr.checks, threads: pr.threads.length });
    } else if (patch.ready === 0 && existing.ready === 1) {
      logTaskEvent(db, task.id, "pr", `PR no longer ready: ${reasons.join(", ") || "gate failing"}`, { pr: pr.url });
    }
  }
  if (merged) await resolveMergedTask(db, hub, task, opts.backend);
  else if (pr.state === "CLOSED") resolveClosedTask(db, hub, task);
  return pr;
}

/** Mirror the PR lifecycle onto the task's Jira ticket: an open PR/MR is
 *  "Code Review", and only a PR Corral itself shows as "ready to merge" (gate
 *  passed *and* a human approved it) is "Ready to merge"; a merge is "Done".
 *  A closed (unmerged) PR moves nothing. Never awaited: the sync is serialized
 *  per ticket, so a slow Jira cannot delay the PR loop. */
function syncJiraPrStage(
  db: Db,
  hub: Hub,
  task: Task,
  pr: PrInfo,
  ready: boolean,
  merged: boolean,
  opts: SyncOptions,
): void {
  if (!task.jira_key) return;
  const jira = opts.jira ?? (opts.cfg?.jira ? new JiraClient(opts.cfg.jira) : null);
  if (!jira) return;
  const stage: JiraStage | null = merged
    ? "done"
    : pr.state === "OPEN"
      ? ready && prReviewLabel(pr) === "ready to merge"
        ? "ready_to_merge"
        : "code_review"
      : null;
  if (!stage) return;
  void syncJiraStage({ db, hub, gateway: jira, statuses: opts.cfg?.jira?.statuses }, task, stage).catch(
    () => undefined,
  );
}

/** The readiness gate's state from the last snapshot taken while the PR was
 *  open, or null when there was none (first seen already merged). */
export function mergeReadiness(prev: PrSnapshot | null): MergeReadiness | null {
  if (!prev || prev.state !== "OPEN") return null;
  return {
    ready: prev.ready,
    reasons: prev.reasons,
    failing_checks: prev.checks.failed,
    pending_checks: prev.checks.pending,
    unresolved_threads: prev.threads.unresolved,
    review_decision: prev.review_decision,
    checked_ms: prev.checked_ms,
  };
}

/** Record the merge once: when it happened and how ready the PR looked just
 *  before. Written whatever the task status: most tasks are already done
 *  (reported) when their PR merges. */
function recordMerge(db: Db, hub: Hub, task: Task, pr: PrInfo, prev: PrSnapshot | null): void {
  const current = db.getTask(task.id);
  if (!current || current.merged_ms != null) return;
  const readiness = mergeReadiness(prev);
  const mergedMs = pr.merged_ms ?? Date.now();
  db.updateTask(task.id, { merged_ms: mergedMs, merge_readiness: readiness ? JSON.stringify(readiness) : null }, false);
  db.recordMetric("pr.merged", task.id, {
    pr: pr.url,
    merged_ms: mergedMs,
    merged_at_known: pr.merged_ms != null,
    ready: readiness ? readiness.ready : null,
    reasons: readiness?.reasons ?? null,
  });
  hub.broadcast("task.updated", db.getTask(task.id));
}

/** A merged or closed PR completes the task, archives its items and frees its worktree. */
async function resolveMergedTask(db: Db, hub: Hub, task: Task, backend: WorkerBackend | undefined): Promise<void> {
  const now = Date.now();
  for (const item of db.listItems()) {
    if (item.task_id !== task.id || item.status === "archived") continue;
    db.updateItem(item.id, { status: "archived", resolved_ms: item.resolved_ms ?? now });
    hub.broadcast("item.updated", db.getItem(item.id));
  }
  completeTask(db, hub, task.id, "merged", "pr-merged", "PR merged — task done, inbox items archived", { pr: db.getTask(task.id)?.pr_url ?? null });
  if (backend) await cleanupFinishedTask(db, backend, task.id, { hub, reason: "pr-closed" });
}

/** A PR closed without merging settles a task whose run already ended: one the
 *  agent reported done, or one already done. A task still being worked on
 *  keeps going (the agent may open another PR). */
function resolveClosedTask(db: Db, hub: Hub, task: Task): void {
  const current = db.getTask(task.id);
  if (!current) return;
  if (!doneReported(current) && current.status !== "done" && current.status !== "archived") return;
  completeTask(db, hub, task.id, "closed", "pr-closed", "PR closed without merging — task done", { pr: current.pr_url });
}

let lastSyncAll = 0;
let syncAllRunning = false;

/** Sync every task that may have a PR. minIntervalMs throttles bursts;
 *  single-flight, a few tasks at a time. */
export async function syncAllPrs(
  db: Db,
  hub: Hub,
  opts: SyncOptions & { knownPrsOnly?: boolean } = {},
  minIntervalMs = 30_000,
): Promise<boolean> {
  const pending = startSyncAllPrs(db, hub, opts, minIntervalMs);
  if (!pending) return false;
  await pending;
  return true;
}

/** Start a sync immediately, or return null when throttled or already running. */
export function startSyncAllPrs(
  db: Db,
  hub: Hub,
  opts: SyncOptions & { knownPrsOnly?: boolean } = {},
  minIntervalMs = 30_000,
): Promise<void> | null {
  const now = Date.now();
  if (syncAllRunning || now - lastSyncAll < minIntervalMs) return null;
  lastSyncAll = now;
  syncAllRunning = true;
  return (async () => {
    try {
      const reportedTasks = new Set(db.listItems({ kind: "pr" }).filter((i) => i.status !== "archived").map((i) => i.task_id));
      const candidates = prCandidateTasks(db);
      const known = new Set(candidates.map((t) => t.id));
      // A task with a live PR item must keep following it even after its
      // session was archived or its branch was cleared. Otherwise a merge
      // leaves an open "ready for review" item nobody checks again.
      const followed = db.listTasks().filter((t) => reportedTasks.has(t.id) && !known.has(t.id));
      const tasks = [...candidates, ...followed].filter((t) => !opts.knownPrsOnly || t.pr_url || reportedTasks.has(t.id));
      // An open PR item promises a current answer. Check it before the rest of
      // the queue: a slow sweep over hundreds of PRs must not keep a merged
      // PR showing as "ready for review" in the inbox.
      tasks.sort((a, b) => Number(reportedTasks.has(b.id)) - Number(reportedTasks.has(a.id)));
      await mapLimit(tasks, 4, (task) => syncTaskPr(db, hub, task, opts).catch(() => null));
      try { archiveEpicLaunchItems(db, hub); } catch (err) { console.error("corral: epic launch cleanup failed:", String(err)); }
      if (opts.backend) {
        try { await cleanupTerminalWorktrees(db, opts.backend, { hub }); }
        catch (err) { console.error("corral: worktree cleanup failed:", String(err)); }
      }
    } finally {
      syncAllRunning = false;
    }
  })();
}

/** Tasks whose branch may have a PR: dispatched/done, with a repo and branch,
 *  excluding done tasks whose PR was already recorded as merged (a merged
 *  PR/MR cannot reopen; polling historical merged tasks stalls the sweep and
 *  burns platform rate limits). Any task that still has a live PR item is
 *  followed separately by startSyncAllPrs. */
export function prCandidateTasks(db: Db): Task[] {
  return db
    .listTasks()
    .filter((t) =>
      isPrSyncedTask(t)
      && (t.status === "dispatched" || t.status === "done")
      && t.branch && t.repo_path
      && !(t.status === "done" && readMeta(t.pr_meta).pr?.state === "MERGED"),
    );
}
