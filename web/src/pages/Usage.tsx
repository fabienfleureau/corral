// Usage — Claude Code + Codex quota, tokens and estimated cost, from local logs.
// Range and metric live in the URL (#/usage?range=30d&metric=tokens).

import { useEffect, useState } from "react";
import { api } from "../api";
import type { AgentQuota, PlatformRateLimit, RateLimitWindow, UsageAgent, UsageRange, UsageReport, UsageTotals } from "../types";
import { errText, formatTs, timeAgo } from "../util";
import { Spinner } from "../ui";

const RANGES: { key: UsageRange; label: string }[] = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All time" },
];
type Metric = "cost" | "tokens";
const AGENT_LABEL: Record<AgentQuota["agent"], string> = { claude: "Claude", codex: "Codex", "opencode-go": "OpenCode Go" };

function paramsFromHash(): { range: UsageRange; metric: Metric } {
  const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const range = q.get("range");
  return {
    range: RANGES.some((r) => r.key === range) ? (range as UsageRange) : "7d",
    metric: q.get("metric") === "tokens" ? "tokens" : "cost",
  };
}

export function usd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return "<$0.01";
  return v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(2)}`;
}

export function tokens(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

const allTokens = (t: UsageTotals) => t.input + t.output + t.cache_read + t.cache_write;

function resetIn(ms: number | null): string {
  if (!ms) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "reset passed";
  const h = Math.floor(diff / 3_600_000);
  if (h >= 48) return `resets in ${Math.round(h / 24)}d`;
  if (h >= 1) return `resets in ${h}h ${Math.floor((diff % 3_600_000) / 60_000)}m`;
  return `resets in ${Math.ceil(diff / 60_000)}m`;
}

function QuotaCard({ q }: { q: AgentQuota }) {
  return (
    <div className="usage-card">
      <div className="usage-card-head">
        <strong>{AGENT_LABEL[q.agent]}</strong>
        {q.plan ? <span className="badge badge-mute">{q.plan}</span> : null}
        {q.stale && q.windows.length ? <span className="badge badge-wait">stale</span> : null}
      </div>
      {q.windows.length === 0 ? <div className="muted">{q.note ?? "No quota data."}</div> : null}
      {q.windows.map((w) => {
        const pct = Math.max(0, Math.min(100, w.used_percent));
        const tone = pct >= 90 ? "usage-bar-hot" : pct >= 70 ? "usage-bar-warm" : "";
        return (
          <div key={w.label} className="usage-quota-row">
            <div className="usage-quota-label">
              <span>{w.label}</span>
              <span className="muted">
                {Math.round(w.used_percent)}% · {resetIn(w.resets_ms)}
              </span>
            </div>
            <div className="usage-bar">
              <div className={`usage-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
      {q.windows.length && q.note ? <div className="muted usage-small">{q.note}</div> : null}
      <div className="muted usage-small" title={q.as_of_ms ? formatTs(q.as_of_ms) : undefined}>
        {q.source}
        {q.as_of_ms ? ` · as of ${timeAgo(q.as_of_ms)}` : ""}
      </div>
    </div>
  );
}

function QuotaBar({ label, detail, usedPercent }: { label: string; detail: string; usedPercent: number }) {
  const pct = Math.max(0, Math.min(100, usedPercent));
  const tone = pct >= 90 ? "usage-bar-hot" : pct >= 70 ? "usage-bar-warm" : "";
  return (
    <div className="usage-quota-row">
      <div className="usage-quota-label">
        <span>{label}</span>
        <span className="muted">{detail}</span>
      </div>
      <div className="usage-bar">
        <div className={`usage-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** One GitHub resource (core, search, graphql) or the GitLab throttle. */
function RateLimitCard({ rl }: { rl: PlatformRateLimit }) {
  return (
    <div className="usage-card">
      <div className="usage-card-head">
        <strong>{rl.host === "github" ? "GitHub API" : "GitLab API"}</strong>
        {rl.windows.length === 0 ? <span className="badge badge-wait">unavailable</span> : null}
      </div>
      {rl.windows.length === 0 ? <div className="muted">{rl.note ?? "No rate limit data."}</div> : null}
      {rl.windows.map((w) => (
        <QuotaBar
          key={w.name}
          label={w.name}
          detail={`${Math.round((w.remaining / w.limit) * 100)}% left · ${resetIn(w.reset_ms)}`}
          usedPercent={((w.limit - w.remaining) / w.limit) * 100}
        />
      ))}
      <div className="muted usage-small" title={formatTs(rl.fetched_ms)}>
        as of {timeAgo(rl.fetched_ms)}
      </div>
    </div>
  );
}

function Timeline({ report, metric }: { report: UsageReport; metric: Metric }) {
  const rows = report.timeline.map((b) => ({
    start: b.start_ms,
    claude: metric === "cost" ? b.claude : b.claude_tokens,
    codex: metric === "cost" ? b.codex : b.codex_tokens,
    opencode: metric === "cost" ? b.opencode_go : b.opencode_go_tokens,
  }));
  const max = Math.max(0, ...rows.map((r) => r.claude + r.codex + r.opencode));
  if (!rows.length || max === 0) return <div className="pane-note">No usage in this range.</div>;
  const fmt = metric === "cost" ? usd : tokens;
  const label = (ms: number) =>
    report.bucket === "hour"
      ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  const every = Math.max(1, Math.ceil(rows.length / 8));
  return (
    <div className="usage-chart">
      <div className="usage-chart-max muted">{fmt(max)}</div>
      <div className="usage-chart-bars">
        {rows.map((r, i) => (
          <div
            key={r.start}
            className="usage-chart-col"
            title={`${label(r.start)} — Claude ${fmt(r.claude)}, Codex ${fmt(r.codex)}, OpenCode Go ${fmt(r.opencode)}`}
          >
            <div className="usage-chart-stack">
              <div className="usage-seg usage-seg-opencode" style={{ height: `${(r.opencode / max) * 100}%` }} />
              <div className="usage-seg usage-seg-codex" style={{ height: `${(r.codex / max) * 100}%` }} />
              <div className="usage-seg usage-seg-claude" style={{ height: `${(r.claude / max) * 100}%` }} />
            </div>
            <div className="usage-chart-x muted">{i % every === 0 ? label(r.start) : ""}</div>
          </div>
        ))}
      </div>
      <div className="usage-legend muted">
        <span><i className="usage-dot usage-seg-claude" /> Claude</span>
        <span><i className="usage-dot usage-seg-codex" /> Codex</span>
        <span><i className="usage-dot usage-seg-opencode" /> OpenCode Go</span>
      </div>
    </div>
  );
}

export function UsagePage() {
  const [{ range, metric }, setParams] = useState(paramsFromHash);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [force, setForce] = useState(false);
  const [linesGroup, setLinesGroup] = useState<"project" | "model" | "task">("project");
  const [limits, setLimits] = useState<PlatformRateLimit[] | null>(null);
  const [limitsReload, setLimitsReload] = useState(0);

  // GitHub/GitLab quota does not depend on the range or the log scan; the server
  // caches it for a minute, so a mount fetch is cheap.
  useEffect(() => {
    let cancelled = false;
    api
      .getRateLimits(limitsReload > 0)
      .then((r) => {
        if (!cancelled) setLimits(r.limits);
      })
      .catch(() => {
        // A missing platform CLI must not break the usage page.
        if (!cancelled) setLimits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [limitsReload]);

  useEffect(() => {
    const onHash = () => setParams(paramsFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const update = (next: { range?: UsageRange; metric?: Metric }) => {
    const p = { range, metric, ...next };
    setParams(p);
    window.history.replaceState(null, "", `#/usage?range=${p.range}${p.metric === "tokens" ? "&metric=tokens" : ""}`);
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    api
      .getUsage(range, force)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        setError(null);
        // First scan still running on the server: poll until it lands.
        if (r.scanning || r.pr_additions.scanning) timer = setTimeout(() => setTick((t) => t + 1), 2000);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setForce(false);
        }
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [range, tick]);

  const eff = report?.efficiency;
  const unpriced = report?.by_model.filter((m) => !m.priced) ?? [];

  return (
    <div className="page usage-page">
      <div className="page-scroll">
        <div className="page-toolbar">
          <h1 className="page-title">Usage</h1>
          <div className="chip-row">
            {RANGES.map((r) => (
              <button key={r.key} className={`chip ${range === r.key ? "chip-active" : ""}`} onClick={() => update({ range: r.key })}>
                {r.label}
              </button>
            ))}
          </div>
          <button
            className="btn"
            disabled={loading}
            onClick={() => {
              setForce(true);
              setTick((t) => t + 1);
              setLimitsReload((n) => n + 1);
            }}
          >
            {loading ? <Spinner /> : null}
            Refresh
          </button>
        </div>

        {error ? <div className="inline-error">{error}</div> : null}
        {!report ? (
          <div className="pane-note">
            <Spinner label="Loading…" />
          </div>
        ) : (
          <>
            {report.scanning ? (
              <div className="pane-note">
                <Spinner label="Reading session usage…" />
              </div>
            ) : null}

            <h2 className="usage-h">Quota</h2>
            <div className="usage-grid">
              {report.quota.map((q) => (
                <QuotaCard key={q.agent} q={q} />
              ))}
            </div>

            <h2 className="usage-h">Platform API</h2>
            <div className="usage-grid">
              {limits === null ? (
                <div className="usage-card">
                  <Spinner label="Reading rate limits…" />
                </div>
              ) : limits.length === 0 ? (
                <div className="usage-card muted">No GitHub or GitLab rate limit data.</div>
              ) : (
                limits.map((rl) => <RateLimitCard key={rl.host} rl={rl} />)
              )}
            </div>

            <h2 className="usage-h">Overview</h2>
            <div className="usage-grid usage-stats">
              <div className="usage-card">
                <div className="muted">Estimated cost</div>
                <div className="usage-big">{usd(report.totals.cost_usd)}</div>
                <div className="muted usage-small">API list prices; subscriptions are not billed per token</div>
              </div>
              <div className="usage-card">
                <div className="muted">Lines added in PRs / MRs</div>
                <div className="usage-big">{report.pr_additions.data ? report.pr_additions.data.additions.toLocaleString() : "—"}</div>
                <div className="muted usage-small">
                  {report.pr_additions.scanning ? "Updating · " : ""}All time · current diffs · {report.pr_additions.data ? `${report.pr_additions.data.available} of ${report.pr_additions.data.total} linked PRs / MRs available` : "loading"}
                </div>
              </div>
              <div className="usage-card">
                <div className="muted">Tokens</div>
                <div className="usage-big">{tokens(allTokens(report.totals))}</div>
                <div className="muted usage-small">
                  {tokens(report.totals.output)} out · {tokens(report.totals.cache_read)} cache read
                </div>
              </div>
              <div className="usage-card">
                <div className="muted">Tasks per $</div>
                <div className="usage-big">{eff && eff.tasks_per_usd !== null ? eff.tasks_per_usd.toFixed(2) : "—"}</div>
                <div className="muted usage-small">
                  {eff ? `${eff.tasks_done} done of ${eff.tasks_with_spend} tasks with spend` : ""}
                </div>
              </div>
              <div className="usage-card">
                <div className="muted">Cost per done task</div>
                <div className="usage-big">{eff && eff.usd_per_done_task !== null ? usd(eff.usd_per_done_task) : "—"}</div>
                <div className="muted usage-small">
                  {eff ? `${usd(eff.unattributed_usd)} spent outside Corral tasks` : ""}
                </div>
              </div>
            </div>

            <div className="usage-section-head">
              <h2 className="usage-h">Over time</h2>
              <div className="chip-row">
                <button className={`chip ${metric === "cost" ? "chip-active" : ""}`} onClick={() => update({ metric: "cost" })}>
                  Cost
                </button>
                <button className={`chip ${metric === "tokens" ? "chip-active" : ""}`} onClick={() => update({ metric: "tokens" })}>
                  Tokens
                </button>
              </div>
            </div>
            <Timeline report={report} metric={metric} />

            <h2 className="usage-h">By model</h2>
            {report.by_model.length === 0 ? (
              <div className="pane-note">No usage in this range.</div>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Model</th>
                    <th className="num">Calls</th>
                    <th className="num">Input</th>
                    <th className="num">Output</th>
                    <th className="num">Cache read</th>
                    <th className="num">Cache write</th>
                    <th className="num">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.by_model.map((m) => (
                    <tr key={`${m.agent}:${m.model}`}>
                      <td>{AGENT_LABEL[m.agent]}</td>
                      <td className="mono">{m.model}</td>
                      <td className="num">{m.calls.toLocaleString()}</td>
                      <td className="num">{tokens(m.input)}</td>
                      <td className="num">{tokens(m.output)}</td>
                      <td className="num">{tokens(m.cache_read)}</td>
                      <td className="num">{tokens(m.cache_write)}</td>
                      <td className="num">{m.priced ? usd(m.cost_usd) : <span className="muted" title="No price for this model">n/a</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {unpriced.length ? (
              <div className="muted usage-small">
                No price for {unpriced.map((m) => m.model).join(", ")} — add it under <code className="mono">usage.prices</code> in{" "}
                <code className="mono">~/.config/corral/config.json</code> (USD per million tokens, e.g.{" "}
                <code className="mono">{'{"gpt-6*": {"input": 1.25, "output": 10}}'}</code>) and restart.
              </div>
            ) : null}

            <h2 className="usage-h">Most expensive tasks</h2>
            {!eff || eff.top_tasks.length === 0 ? (
              <div className="pane-note">No spend attributed to Corral tasks in this range (matched by worktree path).</div>
            ) : (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Status</th>
                    <th>Agent</th>
                    <th className="num">Tokens</th>
                    <th className="num">Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {eff.top_tasks.map((t) => (
                    <tr key={t.id}>
                      <td>{t.title}</td>
                      <td>
                        <span className="badge badge-mute">{t.status}</span>
                      </td>
                      <td>{t.agent === "mixed" ? "mixed" : AGENT_LABEL[t.agent]}</td>
                      <td className="num">{tokens(t.tokens)}</td>
                      <td className="num">{usd(t.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="usage-section-head">
              <h2 className="usage-h">Lines added by {linesGroup}</h2>
              <div className="chip-row">
                {(["project", "model", "task"] as const).map((group) => (
                  <button key={group} className={`chip ${linesGroup === group ? "chip-active" : ""}`} onClick={() => setLinesGroup(group)}>{group[0].toUpperCase() + group.slice(1)}</button>
                ))}
              </div>
            </div>
            <div className="muted usage-small">All time · current PR / MR diffs · model is the task's configured model. Shared PRs count once per group.</div>
            {!report.pr_additions.data ? <div className="pane-note">Loading…</div> : report.pr_additions.data[`by_${linesGroup}`].length === 0 ? <div className="pane-note">No linked PRs / MRs.</div> : (
              <table className="usage-table">
                <thead><tr><th>{linesGroup === "model" ? "Configured model" : linesGroup === "project" ? "Project" : "Task"}</th><th className="num">Lines added</th><th className="num">PRs / MRs available</th></tr></thead>
                <tbody>{report.pr_additions.data[`by_${linesGroup}`].map((row) => (
                  <tr key={row.key}><td>{linesGroup === "task" ? row.key.split("\0")[1] : row.key || (linesGroup === "model" ? "Not pinned" : "Unknown project")}</td><td className="num">{row.available ? row.additions.toLocaleString() : "—"}</td><td className="num">{row.available} / {row.total}</td></tr>
                ))}</tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
