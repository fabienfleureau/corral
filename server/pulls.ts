// Pull Requests page: open/draft PRs & MRs (GitHub + GitLab) where the human
// is awaited — review requested, or authored by them (how agent-created PRs
// appear). Status color per the review rule:
//   red    failing checks / changes requested
//   orange draft, checks running, unresolved threads, or NO SIGNALS YET
//          (a freshly created PR is orange until automated reviews pass)
//   green  checks green, reviews passed, nothing unresolved

import { execFileSync } from "node:child_process";

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

function run(cmd: string, args: string[], timeout = 20_000): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  }).trim();
}

function epochMs(v: unknown): number {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : Date.now();
}

// ---- GitHub ----

function githubLogin(): string | null {
  try {
    return (JSON.parse(run("gh", ["api", "user"])) as { login?: string }).login ?? null;
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
  repository?: { nameWithOwner?: string };
}

function colorize(input: {
  draft: boolean;
  failingChecks: number;
  pendingChecks: number;
  totalChecks: number;
  reviewCount: number;
  changesRequested: boolean;
  unresolvedThreads: number;
}): { color: PullColor; reason: string } {
  if (input.changesRequested) return { color: "red", reason: "changes requested" };
  if (input.failingChecks > 0) return { color: "red", reason: `${input.failingChecks} failing check${input.failingChecks === 1 ? "" : "s"}` };
  if (input.draft) return { color: "orange", reason: "draft" };
  if (input.pendingChecks > 0) return { color: "orange", reason: "checks running" };
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

function githubUnresolvedThreads(url: string): number {
  // https://github.com/owner/repo/pull/123
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return 0;
  const query =
    `query{repository(owner:"${m[1]}",name:"${m[2]}"){pullRequest(number:${Number(m[3])}){` +
    `reviewThreads(first:50){nodes{isResolved comments(first:5){nodes{author{login}}}}}}}`;
  try {
    const gql = JSON.parse(run("gh", ["api", "graphql", "-f", `query=${query}`])) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved?: boolean; comments?: { nodes?: { author?: { login?: string } }[] } }[] } } } };
    };
    const nodes = gql.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
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
    return 0;
  }
}

function listGitHub(): Pull[] {
  const login = githubLogin();
  if (!login) return [];
  const urls = new Set<string>();
  for (const q of [
    `gh search prs --review-requested=${login} --state=open --json url --limit 50`,
  ]) {
    try {
      for (const r of JSON.parse(run("gh", q.split(" ").slice(1))) as { url: string }[]) urls.add(r.url);
    } catch {
      /* search unavailable */
    }
  }
  try {
    for (const r of JSON.parse(run("gh", ["search", "prs", `--author=${login}`, "--state=open", "--json", "url", "--limit", "50"])) as { url: string }[]) {
      urls.add(r.url);
    }
  } catch {
    /* search unavailable */
  }

  const out: Pull[] = [];
  for (const url of urls) {
    try {
      const d = JSON.parse(
        run("gh", [
          "pr", "view", url,
          "--json", "title,url,number,state,isDraft,author,reviewDecision,reviews,statusCheckRollup,mergeable,updatedAt,repository",
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
        unresolvedThreads: githubUnresolvedThreads(d.url),
      });
      const author = d.author?.login ?? "";
      out.push({
        id: d.url,
        host: "github",
        number: Number(d.number) || Number(d.url.match(/\/pull\/(\d+)/)?.[1] ?? 0),
        title: d.title,
        url: d.url,
        repo: d.repository?.nameWithOwner ?? "",
        state: d.isDraft ? "draft" : d.state.toLowerCase(),
        author,
        isMine: author === login,
        awaitingMe: true, // discovered via review-requested or author
        color,
        reason,
        updated_ms: epochMs(d.updatedAt),
      });
    } catch {
      /* skip unreadable PR */
    }
  }
  return out;
}

// ---- GitLab ----

function gitlabLogin(): string | null {
  try {
    return (JSON.parse(run("glab", ["api", "user"])) as { username?: string }).username ?? null;
  } catch {
    return null;
  }
}

interface GlabMR {
  title: string;
  web_url: string;
  iid?: number;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author?: { username?: string };
  head_pipeline?: { status?: string } | null;
  detailed_merge_status?: string;
  blocking_discussions_resolved?: boolean;
  updated_at: string;
}

function listGitLab(): Pull[] {
  const login = gitlabLogin();
  if (!login) return [];
  const seen = new Map<string, GlabMR>();
  for (const q of [
    `merge_requests?scope=all&state=opened&author_username=${login}&per_page=50`,
    `merge_requests?scope=all&state=opened&reviewer_username=${login}&per_page=50`,
  ]) {
    try {
      for (const mr of JSON.parse(run("glab", ["api", q])) as GlabMR[]) seen.set(mr.web_url, mr);
    } catch {
      /* list unavailable */
    }
  }

  const out: Pull[] = [];
  for (const mr of seen.values()) {
    const draft = Boolean(mr.draft ?? mr.work_in_progress);
    const pipeline = mr.head_pipeline?.status ?? null;
    const failing = pipeline === "failed" || pipeline === "canceled";
    const pending = pipeline === "running" || pipeline === "pending" || pipeline === "created" || pipeline === "waiting_for_resource";
    const unresolved = mr.blocking_discussions_resolved === false ? 1 : 0;
    const { color, reason } = colorize({
      draft,
      failingChecks: failing ? 1 : 0,
      pendingChecks: pending ? 1 : 0,
      totalChecks: pipeline ? 1 : 0,
      reviewCount: mr.detailed_merge_status ? 1 : 0, // approvals surface via merge status
      changesRequested: mr.detailed_merge_status === "discussions_not_resolved" && unresolved > 0,
      unresolvedThreads: unresolved,
    });
    const author = mr.author?.username ?? "";
    out.push({
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
    });
  }
  return out;
}

// ---- cache ----

let cache: Pull[] = [];
let lastMs = 0;

export function refreshPulls(): Pull[] {
  const pulls = [...listGitHub(), ...listGitLab()];
  // Awaiting-my-review first, then color severity, then recency.
  const rank: Record<PullColor, number> = { red: 0, orange: 1, green: 2 };
  pulls.sort((a, b) => rank[a.color] - rank[b.color] || b.updated_ms - a.updated_ms);
  cache = pulls;
  lastMs = Date.now();
  return cache;
}

export function cachedPulls(): { pulls: Pull[]; fetched_ms: number } {
  return { pulls: cache, fetched_ms: lastMs };
}
