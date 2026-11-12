// Pull Requests — where the human is awaited (review requested, or authored by
// them, how agent-created PRs show up) plus colleagues' open PRs in the repos
// they can push to. Color is the review signal; Review opens a review task.
// Sorts/filters live in the URL query so filtered views are shareable links.

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Pull, PullColor } from "../types";
import { errText, formatTs, prLabel, timeAgo } from "../util";
import { reviewTaskHash } from "../selection-task";
import { ExternalLinkIcon, Spinner } from "../ui";

const COLOR_LABEL: Record<PullColor, string> = {
  green: "green",
  orange: "pending",
  red: "failing",
};

type ColorFilter = "all" | PullColor;
type StateFilter = "all" | "open" | "draft";
type AuthorFilter = "all" | "mine" | "others";
type HostFilter = "all" | "github" | "gitlab";
type SortKey = "color" | "updated" | "repo" | "title";

interface Filters {
  color: ColorFilter;
  state: StateFilter;
  author: AuthorFilter;
  host: HostFilter;
  repo: string;
  sort: SortKey;
  q: string;
}

const DEFAULTS: Filters = {
  color: "all",
  state: "all",
  author: "all",
  host: "all",
  repo: "all",
  sort: "updated",
  q: "",
};

function filtersFromHash(): Filters {
  const query = window.location.hash.split("?")[1] ?? "";
  const params = new URLSearchParams(query);
  const pick = <T extends string>(key: keyof Filters, allowed: readonly T[], fallback: T): T => {
    const v = params.get(String(key));
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  };
  return {
    color: pick("color", ["all", "green", "orange", "red"] as const, DEFAULTS.color),
    state: pick("state", ["all", "open", "draft"] as const, DEFAULTS.state),
    author: pick("author", ["all", "mine", "others"] as const, DEFAULTS.author),
    host: pick("host", ["all", "github", "gitlab"] as const, DEFAULTS.host),
    repo: params.get("repo") ?? DEFAULTS.repo,
    sort: pick("sort", ["color", "updated", "repo", "title"] as const, DEFAULTS.sort),
    q: params.get("q") ?? DEFAULTS.q,
  };
}

function filtersToHash(f: Filters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== DEFAULTS[k as keyof Filters] && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return `#/pulls${qs ? "?" + qs : ""}`;
}

export function PullsPage({ eventVersion }: { eventVersion: number }) {
  const [pulls, setPulls] = useState<Pull[]>([]);
  const [fetchedMs, setFetchedMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(filtersFromHash);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    window.history.replaceState(null, "", filtersToHash(next));
  };

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      // Manual: ask the server to re-query GitHub/GitLab, not just its cache.
      const res = manual ? await api.refreshPulls() : await api.listPulls();
      setPulls(res.pulls);
      setFetchedMs(res.fetched_ms);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    const onHash = () => setFilters(filtersFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [eventVersion]);

  const repos = useMemo(
    () => [...new Set(pulls.map((p) => p.repo))].filter(Boolean).sort(),
    [pulls],
  );

  const visible = useMemo(() => {
    const rank: Record<PullColor, number> = { red: 0, orange: 1, green: 2 };
    const out = pulls.filter((p) => {
      if (filters.color !== "all" && p.color !== filters.color) return false;
      if (filters.state !== "all" && p.state !== filters.state) return false;
      if (filters.author === "mine" && !p.isMine) return false;
      if (filters.author === "others" && p.isMine) return false;
      if (filters.host !== "all" && p.host !== filters.host) return false;
      if (filters.repo !== "all" && p.repo !== filters.repo) return false;
      if (filters.q && !(p.title + " " + p.repo + " " + p.number).toLowerCase().includes(filters.q.toLowerCase())) return false;
      return true;
    });
    const cmp: Record<SortKey, (a: Pull, b: Pull) => number> = {
      color: (a, b) => rank[a.color] - rank[b.color] || b.updated_ms - a.updated_ms,
      updated: (a, b) => b.updated_ms - a.updated_ms,
      repo: (a, b) => a.repo.localeCompare(b.repo) || rank[a.color] - rank[b.color],
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return [...out].sort(cmp[filters.sort]);
  }, [pulls, filters]);

  return (
    <div className="page pulls-page">
      <div className="page-scroll">
        <div className="page-toolbar">
          <h1 className="page-title">Pull Requests</h1>
          <div className="toolbar-actions">
            <span className="muted">
              {visible.length}/{pulls.length} shown
              {fetchedMs ? ` · updated ${timeAgo(fetchedMs)}` : ""}
            </span>
            <button className="btn" onClick={() => void load(true)} disabled={refreshing}>
              {refreshing ? <Spinner /> : null}
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="pull-filters">
          <div className="chip-row">
            {(
              [
                { key: "all", label: "All" },
                { key: "red", label: "🔴 Failing" },
                { key: "orange", label: "🟟 Pending" },
                { key: "green", label: "🟢 Green" },
              ] as { key: ColorFilter; label: string }[]
            ).map((c) => (
              <button
                key={c.key}
                className={`chip ${filters.color === c.key ? "chip-active" : ""}`}
                onClick={() => set("color", c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <label className="field-inline">
            <span>State</span>
            <select value={filters.state} onChange={(e) => set("state", e.target.value as StateFilter)}>
              <option value="all">all</option>
              <option value="open">open</option>
              <option value="draft">draft</option>
            </select>
          </label>
          <label className="field-inline">
            <span>Author</span>
            <select value={filters.author} onChange={(e) => set("author", e.target.value as AuthorFilter)}>
              <option value="all">all</option>
              <option value="mine">mine</option>
              <option value="others">others</option>
            </select>
          </label>
          <label className="field-inline">
            <span>Host</span>
            <select value={filters.host} onChange={(e) => set("host", e.target.value as HostFilter)}>
              <option value="all">all</option>
              <option value="github">github</option>
              <option value="gitlab">gitlab</option>
            </select>
          </label>
          <label className="field-inline">
            <span>Repo</span>
            <select value={filters.repo} onChange={(e) => set("repo", e.target.value)}>
              <option value="all">all</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            <span>Sort</span>
            <select value={filters.sort} onChange={(e) => set("sort", e.target.value as SortKey)}>
              <option value="color">severity</option>
              <option value="updated">recently updated</option>
              <option value="repo">repo</option>
              <option value="title">title</option>
            </select>
          </label>
          <input
            className="pull-search"
            placeholder="Search title or repo…"
            value={filters.q}
            onChange={(e) => set("q", e.target.value)}
          />
        </div>

        {error ? <div className="inline-error">{error}</div> : null}
        {loading && pulls.length === 0 ? (
          <div className="pane-note">
            <Spinner label="Loading…" />
          </div>
        ) : visible.length === 0 ? (
          <div className="pane-note">
            {pulls.length === 0
              ? "Nothing here yet. Your review requests, your own PRs and your colleagues' open PRs appear here."
              : "No PRs match these filters."}
          </div>
        ) : (
          <div className="pull-list">
            {visible.map((p) => (
              <div key={p.id} className={`pull-row pull-${p.color}`}>
                <span className={`dot dot-${p.color}`} title={p.reason} />
                <div className="pull-main">
                  <div className="pull-title">
                    <span className={`badge badge-${p.host === "github" ? "mute" : "target"}`}>{p.host}</span>
                    <span className="pull-number mono" title={`${p.host} number`}>
                      {p.host === "gitlab" ? "!" : "#"}
                      {p.number}
                    </span>
                    <a href={p.url} target="_blank" rel="noreferrer" className="pull-link">
                      {p.title}
                      <ExternalLinkIcon />
                    </a>
                    {p.state === "draft" ? <span className="badge badge-wait">draft</span> : <span className="badge">open</span>}
                    {p.isMine ? <span className="badge badge-mine">you are author</span> : <span className="badge badge-mute">author: {p.author}</span>}
                    {!p.isMine && p.awaitingMe ? <span className="badge badge-wait" title="Your review is requested">review requested</span> : null}
                  </div>
                  <div className="pull-sub">
                    <span className="mono muted">{p.repo}</span>
                    <span className={`pull-status pull-${p.color}`}>{COLOR_LABEL[p.color]} — {p.reason}</span>
                    <span className="time muted" title={formatTs(p.updated_ms)}>
                      updated {timeAgo(p.updated_ms)}
                    </span>
                  </div>
                </div>
                <a className="btn pull-review" href={reviewTaskHash(p.url)} title={`Dispatch a review of ${prLabel(p.url)}`}>
                  Review
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
