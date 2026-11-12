// Pull Requests page: open/draft PRs & MRs (GitHub + GitLab) where the human
// is awaited — review requested, or authored by them (how agent-created PRs
// appear). Status color per the review rule:
//   red    failing checks / changes requested
//   orange draft, checks running, unresolved threads, or NO SIGNALS YET
//          (a freshly created PR is orange until automated reviews pass)
//   green  checks green, reviews passed, nothing unresolved

import type { Hub } from "./capture.ts";
import { mapLimit, runAsync } from "./exec.ts";
import { errors } from "./errors.ts";

export type PullColor = "green" | "orange" | "red";

export interface Pull {
  id: string;
  host: "github" | "gitlab";
  number: number;
  title: string;
  url: string;
  repo: string;
  /** open | draft | merged | closed */
  state: string;
  author: string;
  isMine: boolean;
  awaitingMe: boolean;
  color: PullColor;
  /** Why the color is what it is ("checks running", "no reviews yet", …). */
  reason: string;
  updated_ms: number;
}

function run(cmd: string, args: string[], timeout = 20_000): Promise<string> {
  return runAsync(cmd, args, { timeout });
}

/** Per-PR platform calls in flight at once. */
const CONCURRENCY = 4;

function epochMs(v: unknown): number {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : Date.now();
}

// ---- GitHub ----

async function githubLogin(): Promise<string | null> {
  try {
    return (JSON.parse(await run("gh", ["api", "user"])) as { login?: string }).login ?? null;
  } catch {
    return null;
  }
}

interface GhPullBrief {
  title: string;
  url: string;
  number: number;
  state: string;
  isDraft: boolean;
  author: { login: string };
  reviewDecision: string | null;
  reviews: { state: string }[];
  statusCheckRollup: unknown[];
  mergeable: string;
  updatedAt: string;
}

function colorize(input: {
  draft: boolean;
  failingChecks: number;
  pendingChecks: number;
  totalChecks: number;
  reviewCount: number;
  changesRequested: boolean;
  /** null = thread data unavailable. */
  unresolvedThreads: number | null;
}): { color: PullColor; reason: string } {
  if (input.changesRequested) return { color: "red", reason: "changes requested" };
  if (input.failingChecks > 0) return { color: "red", reason: `${input.failingChecks} failing check${input.failingChecks === 1 ? "" : "s"}` };
  if (input.draft) return { color: "orange", reason: "draft" };
  if (input.pendingChecks > 0) return { color: "orange", reason: "checks running" };
  if (input.unresolvedThreads === null) return { color: "orange", reason: "review comments unavailable" };
  if (input.unresolvedThreads > 0) return { color: "orange", reason: `${input.unresolvedThreads} unresolved review comment${input.unresolvedThreads === 1 ? "" : "s"}` };
  if (input.totalChecks === 0 && input.reviewCount === 0) {
    // The "freshly created" rule: no automated review has passed yet.
    return { color: "orange", reason: "no reviews yet" };
  }
  if (input.totalChecks === 0) return { color: "green", reason: "reviewed, no checks configured" };
  return { color: "green", reason: "checks green, reviewed" };
}

function summarizeChecks(rollup: unknown[]): { failing: number; pending: number; total: number } {
  let failing = 0;
  let pending = 0;
  for (const raw of rollup) {
    const c = raw as Record<string, unknown>;
    const state = String(c.conclusion ?? c.state ?? "").toUpperCase();
    const status = String(c.status ?? "").toUpperCase();
    if (state === "SUCCESS" || state === "NEUTRAL" || state === "SKIPPED") continue;
    if (state === "" || state === "PENDING" || state === "EXPECTED" || state === "QUEUED" || status === "IN_PROGRESS" || status === "QUEUED") {
      pending++;
    } else {
      failing++;
    }
  }
  return { failing, pending, total: rollup.length };
}

/** "owner/repo" from https://github.com/owner/repo/pull/123 */
export function githubRepoFromUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//);
  return m ? `${m[1]}/${m[2]}` : "";
}

/** Unresolved, unanswered threads; null when the query fails. */
async function githubUnresolvedThreads(url: string): Promise<number | null> {
  // https://github.com/owner/repo/pull/123
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const query =
    `query{repository(owner:"${m[1]}",name:"${m[2]}"){pullRequest(number:${Number(m[3])}){` +
    `reviewThreads(first:50){nodes{isResolved comments(first:5){nodes{author{login}}}}}}}`;
  try {
    const gql = JSON.parse(await run("gh", ["api", "graphql", "-f", `query=${query}`])) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved?: boolean; comments?: { nodes?: { author?: { login?: string } }[] } }[] } } } };
    };
    const nodes = gql.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!nodes) return null;
    let unresolved = 0;
    for (const t of nodes) {
      if (t.isResolved) continue;
      const comments = t.comments?.nodes ?? [];
      const first = comments[0]?.author?.login ?? "";
      const last = comments[comments.length - 1]?.author?.login ?? "";
      if (comments.length > 1 && first !== last) continue; // answered
      unresolved++;
    }
    return unresolved;
  } catch {
    return null;
  }
}

async function searchUrls(args: string[]): Promise<string[]> {
  try {
    return (JSON.parse(await run("gh", ["search", "prs", ...args, "--state=open", "--json", "url", "--limit", "50"])) as { url: string }[]).map((r) => r.url);
  } catch {
    return []; // search unavailable
  }
}

async function githubPull(url: string, login: string): Promise<Pull | null> {
  try {
    const d = JSON.parse(
      await run("gh", [
        "pr", "view", url,
        "--json", "title,url,number,state,isDraft,author,reviewDecision,reviews,statusCheckRollup,mergeable,updatedAt",
      ]),
    ) as GhPullBrief;
    const checks = summarizeChecks(d.statusCheckRollup ?? []);
    const { color, reason } = colorize({
      draft: Boolean(d.isDraft),
      failingChecks: checks.failing,
      pendingChecks: checks.pending,
      totalChecks: checks.total,
      reviewCount: (d.reviews ?? []).length,
      changesRequested: d.reviewDecision === "CHANGES_REQUESTED",
      unresolvedThreads: await githubUnresolvedThreads(d.url),
    });
    const author = d.author?.login ?? "";
    return {
      id: d.url,
      host: "github",
      number: Number(d.number) || Number(d.url.match(/\/pull\/(\d+)/)?.[1] ?? 0),
      title: d.title,
      url: d.url,
      repo: githubRepoFromUrl(d.url),
      state: d.isDraft ? "draft" : d.state.toLowerCase(),
      author,
      isMine: author === login,
      awaitingMe: true, // discovered via review-requested or author
      color,
      reason,
      updated_ms: epochMs(d.updatedAt),
    };
  } catch {
    return null; // skip unreadable PR
  }
}

async function listGitHub(): Promise<Pull[]> {
  const login = await githubLogin();
  if (!login) return [];
  const found = await Promise.all([searchUrls([`--review-requested=${login}`]), searchUrls([`--author=${login}`])]);
  const urls = [...new Set(found.flat())];
  const pulls = await mapLimit(urls, CONCURRENCY, (url) => githubPull(url, login));
  return pulls.filter((p): p is Pull => p !== null);
}

// ---- GitLab ----

async function gitlabLogin(): Promise<string> {
  const login = (JSON.parse(await run("glab", ["api", "user"])) as { username?: string }).username;
  if (!login) throw new Error("GitLab returned no username");
  return login;
}

interface GlabMR {
  title: string;
  web_url: string;
  iid?: number;
  project_id?: number;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author?: { username?: string };
  head_pipeline?: { status?: string } | null;
  detailed_merge_status?: string;
  blocking_discussions_resolved?: boolean;
  updated_at: string;
}

async function gitlabPull(mr: GlabMR, login: string): Promise<Pull> {
  const draft = Boolean(mr.draft ?? mr.work_in_progress);
  const base = `projects/${mr.project_id}/merge_requests/${mr.iid}`;
  // The list endpoint carries no pipeline and no approvals: fetch both.
  const [full, approvals] = await Promise.all([
    run("glab", ["api", base]).then((s) => JSON.parse(s) as GlabMR).catch(() => null),
    run("glab", ["api", `${base}/approvals`])
      .then((s) => JSON.parse(s) as { approved_by?: unknown[] })
      .catch(() => null),
  ]);
  const pipeline = full ? (full.head_pipeline?.status ?? null) : "unknown";
  const failing = pipeline === "failed" || pipeline === "canceled";
  const pending = pipeline !== null && !failing && pipeline !== "success" && pipeline !== "skipped" && pipeline !== "manual";
  const unresolved = mr.blocking_discussions_resolved === false ? 1 : 0;
  const { color, reason } = colorize({
    draft,
    failingChecks: failing ? 1 : 0,
    pendingChecks: pending ? 1 : 0,
    totalChecks: pipeline ? 1 : 0,
    reviewCount: approvals?.approved_by?.length ?? 0,
    changesRequested: full?.detailed_merge_status === "requested_changes",
    unresolvedThreads: unresolved,
  });
  const author = mr.author?.username ?? "";
  return {
    id: mr.web_url,
    host: "gitlab",
    number: Number(mr.iid) || Number(mr.web_url.match(/merge_requests\/(\d+)/)?.[1] ?? 0),
    title: mr.title,
    url: mr.web_url,
    repo: mr.web_url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/-\/merge_requests\/.*$/, ""),
    state: draft ? "draft" : mr.state.toLowerCase() === "opened" ? "open" : mr.state.toLowerCase(),
    author,
    isMine: author === login,
    awaitingMe: true,
    color,
    reason: pipeline ? reason : reason === "reviewed, no checks configured" ? "no pipeline yet" : reason,
    updated_ms: epochMs(mr.updated_at),
  };
}

async function listGitLab(): Promise<Pull[]> {
  const login = await gitlabLogin();
  if (!login) return [];
  const seen = new Map<string, GlabMR>();
  const lists = await Promise.all(
    [
      `merge_requests?scope=all&state=opened&author_username=${login}&per_page=50`,
      `merge_requests?scope=all&state=opened&reviewer_username=${login}&per_page=50`,
    ].map((q) => run("glab", ["api", q]).then((s) => JSON.parse(s) as GlabMR[])),
  );
  for (const mr of lists.flat()) seen.set(mr.web_url, mr);
  return mapLimit([...seen.values()], CONCURRENCY, (mr) => gitlabPull(mr, login));
}

// ---- platform API rate limits ----
// The PR loop spends API quota on both platforms, so the Usage page shows how
// much is left. GitHub answers /rate_limit without spending quota; GitLab only
// exposes its throttle in response headers, so it costs one cheap call.

export interface RateLimitWindow {
  /** "core", "search", "graphql", or the GitLab throttle name. */
  name: string;
  limit: number;
  remaining: number;
  /** Epoch ms; null when the platform sends no reset. */
  reset_ms: number | null;
}

export interface PlatformRateLimit {
  host: "github" | "gitlab";
  /** Empty when the fetch failed — then `note` says why. */
  windows: RateLimitWindow[];
  note: string | null;
  fetched_ms: number;
}

function window(name: string, raw: { limit?: unknown; remaining?: unknown; reset?: unknown } | undefined): RateLimitWindow | null {
  const limit = Number(raw?.limit);
  const remaining = Number(raw?.remaining);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return null;
  const reset = Number(raw?.reset);
  return { name, limit, remaining, reset_ms: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null };
}

/** Windows the PR loop consumes, from `gh api rate_limit`. */
export function parseGitHubRateLimit(json: string): RateLimitWindow[] {
  const data = JSON.parse(json) as { resources?: Record<string, { limit?: unknown; remaining?: unknown; reset?: unknown }> };
  const out: RateLimitWindow[] = [];
  for (const name of ["core", "search", "graphql"]) {
    const w = window(name, data.resources?.[name]);
    if (w) out.push(w);
  }
  return out;
}

/** The authenticated throttle, from `glab api -i` headers. */
export function parseGitLabRateHeaders(output: string): RateLimitWindow[] {
  const [head = ""] = output.split(/\r?\n\r?\n/);
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  const limit = headers.get("ratelimit-limit");
  const remaining = headers.get("ratelimit-remaining");
  if (!limit || !remaining) return [];
  const reset = Number(headers.get("ratelimit-reset"));
  const name = (headers.get("ratelimit-name") || "api").replace(/^throttle_/, "").replace(/_/g, " ");
  return [{
    name,
    limit: Number(limit),
    remaining: Number(remaining),
    reset_ms: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null,
  }].filter((w) => Number.isFinite(w.limit) && Number.isFinite(w.remaining) && w.limit > 0);
}

async function githubRateLimit(): Promise<PlatformRateLimit> {
  try {
    const windows = parseGitHubRateLimit(await run("gh", ["api", "rate_limit"]));
    if (!windows.length) throw new Error("no rate limit resources in the answer");
    return { host: "github", windows, note: null, fetched_ms: Date.now() };
  } catch (err) {
    return { host: "github", windows: [], note: err instanceof Error ? err.message : String(err), fetched_ms: Date.now() };
  }
}

async function gitlabRateLimit(): Promise<PlatformRateLimit> {
  try {
    const windows = parseGitLabRateHeaders(await run("glab", ["api", "-i", "user"]));
    if (!windows.length) throw new Error("no rate limit headers in the answer");
    return { host: "gitlab", windows, note: null, fetched_ms: Date.now() };
  } catch (err) {
    return { host: "gitlab", windows: [], note: err instanceof Error ? err.message : String(err), fetched_ms: Date.now() };
  }
}

/** One platform call per minute, shared by concurrent polls. */
const RATE_LIMIT_TTL_MS = 60_000;
let rateCache: { at: number; value: PlatformRateLimit[] } | null = null;
let rateInflight: Promise<PlatformRateLimit[]> | null = null;

export function platformRateLimits(force = false): Promise<PlatformRateLimit[]> {
  if (!force && rateCache && Date.now() - rateCache.at < RATE_LIMIT_TTL_MS) return Promise.resolve(rateCache.value);
  rateInflight ??= Promise.all([githubRateLimit(), gitlabRateLimit()])
    .then((value) => {
      rateCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      rateInflight = null;
    });
  return rateInflight;
}

// ---- cache ----

let cache: Pull[] = [];
let lastMs = 0;
let inflight: Promise<Pull[]> | null = null;

/** Refresh from both platforms (single-flight) and tell open pages. */
export function refreshPulls(hub?: Hub): Promise<Pull[]> {
  inflight ??= doRefresh(hub).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh(hub?: Hub): Promise<Pull[]> {
  const [gh, gl] = await Promise.all([
    listGitHub(),
    listGitLab().then((pulls) => { errors.clear("GitLab sync"); return pulls; }).catch((err: unknown) => {
      errors.fail("GitLab sync", err);
      return cache.filter((pull) => pull.host === "gitlab");
    }),
  ]);
  const pulls = [...gh, ...gl];
  // Awaiting-my-review first, then color severity, then recency.
  const rank: Record<PullColor, number> = { red: 0, orange: 1, green: 2 };
  pulls.sort((a, b) => rank[a.color] - rank[b.color] || b.updated_ms - a.updated_ms);
  cache = pulls;
  lastMs = Date.now();
  hub?.broadcast("pulls.updated", { fetched_ms: lastMs });
  return cache;
}

export function cachedPulls(): { pulls: Pull[]; fetched_ms: number } {
  return { pulls: cache, fetched_ms: lastMs };
}
