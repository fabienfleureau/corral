// Self-improvement — analyses of how work and agents are going. Each one runs
// on demand or on a schedule and delivers its proposals to the inbox; none of
// them changes anything or dispatches a task.

import { useEffect, useId, useState } from "react";
import { api } from "../api";
import type { AnalysisStatus } from "../api";
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
