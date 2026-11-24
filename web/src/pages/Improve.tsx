// Self-improvement — analyses of how work and agents are going. Each one runs
// on demand or on a schedule and delivers its proposals to the inbox; none of
// them changes anything or dispatches a task.

import { useEffect, useId, useState } from "react";
import { api } from "../api";
import type { AnalysisStatus } from "../api";
import type { PrWaitSplit, RateCounts, StoppedRunRate, WaitStats } from "../../../shared/improvement-metrics";
import type { Repo } from "../types";
import { errText } from "../util";

interface AnalysisPanelProps {
  title: string;
  /** What the analysis does and what is sent to the assistant. */
  intro: string;
  /** Names the controls, so two panels on one page never share an accessible name. */
  subject: string;
  status: () => Promise<AnalysisStatus>;
  setSchedule: (days: number) => Promise<AnalysisStatus>;
  run: () => Promise<unknown>;
  doneMessage: string;
}

function AnalysisPanel({ title, intro, subject, status: loadStatus, setSchedule, run, doneMessage }: AnalysisPanelProps) {
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const scheduleId = useId();

  useEffect(() => {
    const refresh = () => loadStatus().then(setStatus).catch((e: unknown) => setError(errText(e)));
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  const schedule = async (days: number) => {
    setBusy(true); setError(""); setMessage("");
    try { setStatus(await setSchedule(days)); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const start = async () => {
    setBusy(true); setError(""); setMessage("");
    try { await run(); setStatus(await loadStatus()); setMessage(doneMessage); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return <section className="panel-form" aria-busy={busy || status?.running === true}>
    <h2 className="panel-title">{title}</h2>
    <p className="muted">{intro}</p>
    <div className="field">
      <label htmlFor={scheduleId}>Run automatically <span className="visually-hidden">({subject})</span></label>
      <select id={scheduleId} value={status?.intervalDays ?? 0} disabled={!status || busy} onChange={(e) => void schedule(Number(e.target.value))}>
        <option value={0}>Off</option><option value={1}>Daily</option><option value={7}>Weekly</option><option value={30}>Every 30 days</option>
      </select>
    </div>
    <p className="muted">Runs while Corral is open. Missed runs start after restart. {status?.lastSuccessMs ? `Last started: ${new Date(status.lastSuccessMs).toLocaleString()}.` : "No analysis started yet."}</p>
    {status?.error ? <div className="inline-error" role="alert">Last run failed: {status.error}</div> : null}
    {error ? <div className="inline-error" role="alert">{error}</div> : null}
    {message ? <div className="inline-ok" role="status">{message} <a href="#/tasks">Open tasks</a></div> : null}
    <div className="form-foot">
      <button className="btn btn-primary" disabled={busy || !status || status.running} onClick={() => void start()}>
        {busy ? "Running…" : status?.running ? "Analysis running…" : "Run analysis now"}
        <span className="visually-hidden"> ({subject})</span>
      </button>
    </div>
  </section>;
}

const DAY = 86_400_000;

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function rateCell(c: RateCounts) {
  if (c.rate === null) return <span className="muted">no dispatch</span>;
  return <>{Math.round(c.rate * 100)}% <span className="muted">({c.escalations}/{c.dispatches})</span></>;
}

/** Stopped or failed runs escalated to the inbox, per dispatch, around a pivot
 *  (by default the merge of the automatic retry, ADR 0016). */
function StoppedRunsPanel() {
  const [pivot, setPivot] = useState("");
  const [days, setDays] = useState(14);
  const [data, setData] = useState<StoppedRunRate | null>(null);
  const [error, setError] = useState("");
  const pivotId = useId();
  const daysId = useId();
  const captionId = useId();

  useEffect(() => {
    let live = true;
    api.improvementMetrics({ days, pivot: pivot || undefined })
      .then((m) => { if (live) { setData(m.stopped_runs); setError(""); } })
      .catch((e: unknown) => { if (live) setError(errText(e)); });
    return () => { live = false; };
  }, [pivot, days]);

  const afterDays = data ? Math.round((data.after.end_ms - data.after.start_ms) / DAY * 10) / 10 : 0;
  return <section className="panel-form">
    <h2 className="panel-title">Runs that stopped without reporting</h2>
    <p className="muted">Inbox escalations of stopped or failed agent runs, divided by dispatches, per harness. An escalation counts in the window where its run was dispatched. The default pivot is the automatic retry (ADR 0016).</p>
    <div className="improve-metric-controls">
      <div className="field"><label htmlFor={pivotId}>Pivot date</label>
        <input id={pivotId} type="date" value={pivot || (data ? day(data.pivot_ms) : "")} onChange={(e) => setPivot(e.target.value)} />
      </div>
      <div className="field"><label htmlFor={daysId}>Window</label>
        <select id={daysId} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
        </select>
      </div>
    </div>
    {error ? <div className="inline-error" role="alert">{error}</div> : null}
    {data ? <>
      <div className="improve-table-wrap" tabIndex={0} role="region" aria-labelledby={captionId}>
        <table className="usage-table">
          <caption id={captionId} className="visually-hidden">Stopped-run rate per harness, before and after the pivot</caption>
          <thead><tr>
            <th scope="col">Harness</th>
            <th scope="col" className="num">Before ({day(data.before.start_ms)} → {day(data.before.end_ms)})</th>
            <th scope="col" className="num">After ({day(data.after.start_ms)} → {day(data.after.end_ms)}, {afterDays} d)</th>
          </tr></thead>
          <tbody>
            {data.by_harness.map((r) => <tr key={r.harness}>
              <th scope="row">{r.harness}</th>
              <td className="num">{rateCell(r.before)}</td>
              <td className="num">{rateCell(r.after)}</td>
            </tr>)}
            <tr><th scope="row">All</th><td className="num">{rateCell(data.total.before)}</td><td className="num">{rateCell(data.total.after)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="muted">Recognised by marker {data.sources.marker}, capture event {data.sources.capture_event}, title {data.sources.title}. Rows older than the marker miss reopened escalations.</p>
    </> : null}
  </section>;
}

function duration(ms: number | null): string {
  if (ms === null) return "–";
  const hours = ms / 3_600_000;
  return hours < 48 ? `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h` : `${(hours / 24).toFixed(1)} d`;
}

function waitCell(w: WaitStats) {
  if (!w.count) return <span className="muted">–</span>;
  return <>{duration(w.p50_ms)} <span className="muted">/ {duration(w.p90_ms)}</span></>;
}

function repoName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Where a PR-backed task waits: on the agent (to the first ready for review)
 *  or on the human reviewer (from ready to merge or close). */
function PrWaitPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<PrWaitSplit | null>(null);
  const [error, setError] = useState("");
  const daysId = useId();
  const captionId = useId();

  useEffect(() => {
    let live = true;
    api.improvementMetrics({ waitDays: days })
      .then((m) => { if (live) { setData(m.pr_wait); setError(""); } })
      .catch((e: unknown) => { if (live) setError(errText(e)); });
    return () => { live = false; };
  }, [days]);

  return <section className="panel-form">
    <h2 className="panel-title">Agent time and reviewer time on PRs</h2>
    <p className="muted">For PRs that became ready for review in the window: agent time runs from the first dispatch to the first ready for review (CI and automated reviews included), reviewer time from there to merge or close (snoozes included). Median / p90.</p>
    <div className="improve-metric-controls">
      <div className="field"><label htmlFor={daysId}>Window</label>
        <select id={daysId} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
        </select>
      </div>
    </div>
    {error ? <div className="inline-error" role="alert">{error}</div> : null}
    {data ? <>
      <div className="improve-table-wrap" tabIndex={0} role="region" aria-labelledby={captionId}>
        <table className="usage-table">
          <caption id={captionId} className="visually-hidden">Agent and reviewer time per repository, median and p90</caption>
          <thead><tr>
            <th scope="col">Repository</th>
            <th scope="col" className="num">PRs</th>
            <th scope="col" className="num">Agent time</th>
            <th scope="col" className="num">Reviewer time</th>
            <th scope="col" className="num">Awaiting review</th>
          </tr></thead>
          <tbody>
            {[...data.by_repo, data.total].map((r) => <tr key={r.repo}>
              <th scope="row" title={r.repo}>{r.repo === "all" ? "All" : repoName(r.repo)}</th>
              <td className="num">{r.prs}</td>
              <td className="num">{waitCell(r.agent)}</td>
              <td className="num">{waitCell(r.reviewer)}</td>
              <td className="num">{r.awaiting_review}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className="muted">{data.never_ready} PR{data.never_ready === 1 ? "" : "s"} opened in the window never became ready. Review tasks are left out.</p>
    </> : null}
  </section>;
}

export function ImprovePage() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repo, setRepo] = useState("");
  const [repoError, setRepoError] = useState("");
  useEffect(() => { void Promise.all([api.listRepos(), api.analysisRepo()]).then(([list, saved]) => { setRepos(list); setRepo(saved.repo); }).catch((e: unknown) => setRepoError(errText(e))); }, []);
  return <div className="page settings-page">
    <div className="page-scroll">
      <div className="page-toolbar">
        <h1 className="page-title">Self-improvement</h1>
      </div>
      <section className="panel-form">
        <div className="field"><label htmlFor="analysis-repo">Repository for analyses</label>
          <select id="analysis-repo" value={repo} onChange={(e) => { const value = e.target.value; void api.setAnalysisRepo(value).then((result) => { setRepo(result.repo); setRepoError(""); }).catch((error: unknown) => setRepoError(errText(error))); }}>
            <option value="">Select a repository</option>
            {repo && !repos.some((r) => r.path === repo) ? <option value={repo}>{repo}</option> : null}
            {repos.map((r) => <option value={r.path} key={r.path}>{r.name} — {r.path}</option>)}
          </select>
        </div>
        {repoError ? <div className="inline-error" role="alert">{repoError}</div> : null}
      </section>
      <StoppedRunsPanel />
      <PrWaitPanel />
      <div className="settings-grid">
        <AnalysisPanel
          title="Engineering improvement analysis"
          subject="engineering improvement"
          intro="Review recent task and PR activity for delays, rework and improvement proposals. The agent receives task titles, PR links, inbox item metadata and event metadata. Each run starts an agent task and reports its findings in your inbox."
          status={api.improvementStatus}
          setSchedule={api.setImprovementSchedule}
          run={api.runImprovement}
          doneMessage="Analysis task started."
        />
        <AnalysisPanel
          title="Engineering skills analysis"
          subject="engineering skills"
          intro="Find learning topics and exercises grounded in your recent Corral activity. The agent receives task and PR metadata, event data, and clipped, redacted task descriptions and inbox questions. Activity alone cannot establish your proficiency. Each run starts an agent task and reports its findings in your inbox."
          status={api.engineeringSkillsStatus}
          setSchedule={api.setEngineeringSkillsSchedule}
          run={api.runEngineeringSkills}
          doneMessage="Analysis task started."
        />
        <AnalysisPanel
          title="Skills analysis"
          subject="skills"
          intro="Compare the skills installed on this machine with your last 90 days of Claude Code and Codex sessions: which look obsolete, and which new ones are worth writing. The agent receives each skill's name, description and opening lines (not the text of plugin skills), invocation counts, and the first prompt of recent sessions, truncated and stripped of boilerplate and secrets. Each run starts an agent task and reports draft skills in your inbox; no skills are changed."
          status={api.skillsAnalysisStatus}
          setSchedule={api.setSkillsAnalysisSchedule}
          run={api.runSkillsAnalysis}
          doneMessage="Skills analysis task started."
        />
      </div>
    </div>
  </div>;
}
