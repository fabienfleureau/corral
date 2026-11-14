// Self-improvement — analyses of how work and agents are going. Each one runs
// on demand or on a schedule and delivers its proposals to the inbox; none of
// them changes anything or dispatches a task.

import { useEffect, useId, useState } from "react";
import { api } from "../api";
import type { AnalysisStatus } from "../api";
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
    <p className="muted">Runs while Corral is open. Missed runs start after restart. {status?.lastSuccessMs ? `Last completed: ${new Date(status.lastSuccessMs).toLocaleString()}.` : "No analysis completed yet."}</p>
    {status?.error ? <div className="inline-error" role="alert">Last run failed: {status.error}</div> : null}
    {error ? <div className="inline-error" role="alert">{error}</div> : null}
    {message ? <div className="inline-ok" role="status">{message} <a href="#/inbox">Open inbox</a></div> : null}
    <div className="form-foot">
      <button className="btn btn-primary" disabled={busy || !status || status.running} onClick={() => void start()}>
        {busy ? "Running…" : status?.running ? "Analysis running…" : "Run analysis now"}
        <span className="visually-hidden"> ({subject})</span>
      </button>
    </div>
  </section>;
}

export function ImprovePage() {
  return <div className="page settings-page">
    <div className="page-scroll">
      <div className="page-toolbar">
        <h1 className="page-title">Self-improvement</h1>
      </div>
      <div className="settings-grid">
        <AnalysisPanel
          title="Engineering improvement analysis"
          subject="engineering improvement"
          intro="Review recent task and PR activity for delays, rework and improvement proposals. The configured assistant receives task titles, PR links, inbox item metadata and event metadata. Reports appear in your inbox; no tasks are dispatched."
          status={api.improvementStatus}
          setSchedule={api.setImprovementSchedule}
          run={api.runImprovement}
          doneMessage="Analysis is in your inbox."
        />
        <AnalysisPanel
          title="Skills analysis"
          subject="skills"
          intro="Compare the skills installed on this machine with your last 90 days of Claude Code and Codex sessions: which look obsolete, and which new ones are worth writing. The configured assistant receives each skill's name, description and opening lines (not the text of plugin skills), invocation counts, and the first prompt of recent sessions, truncated and stripped of boilerplate and secrets. Reports appear in your inbox with draft skills; nothing is created or changed."
          status={api.skillsAnalysisStatus}
          setSchedule={api.setSkillsAnalysisSchedule}
          run={api.runSkillsAnalysis}
          doneMessage="Skills analysis is in your inbox."
        />
      </div>
    </div>
  </div>;
}
