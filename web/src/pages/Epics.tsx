// Epics: a Jira epic as an ordered list of tasks, with what blocks each one and
// how far the whole thing got. Jira owns the structure; resync pulls it again.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Epic, EpicDetail, EpicSummary, EpicTaskState, Repo } from "../types";
import { Spinner } from "../ui";
import { errText } from "../util";

const STATE_LABEL: Record<EpicTaskState, string> = {
  out: "left the epic",
  merged: "merged",
  pr_ready: "PR ready",
  pr_open: "PR open",
  running: "running",
  ready: "ready to launch",
  blocked: "blocked",
};

const STATE_BADGE: Record<EpicTaskState, string> = {
  out: "badge",
  merged: "badge badge-ready",
  pr_ready: "badge badge-ready",
  pr_open: "badge badge-wait",
  running: "badge badge-mine",
  ready: "badge badge-ready",
  blocked: "badge badge-wait",
};

export function summaryText(s: EpicSummary): string {
  const parts = [`${s.merged}/${s.total} merged`, `${s.testable} testable`];
  if (s.ready) parts.push(`${s.ready} ready to launch`);
  if (s.blocked) parts.push(`${s.blocked} blocked`);
  return parts.join(" · ");
}

export function EpicsPage({ eventVersion, refresh }: { eventVersion: number; refresh: () => void }) {
  const [epics, setEpics] = useState<(Epic & { summary: EpicSummary })[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EpicDetail | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listEpics().then((rows) => { if (!cancelled) { setEpics(rows); setSelectedId((id) => id ?? rows[0]?.id ?? null); } }).catch((e) => { if (!cancelled) setError(errText(e)); });
    api.listRepos().then((rows) => { if (!cancelled) setRepos(rows); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [eventVersion]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    api.getEpic(selectedId).then((d) => { if (!cancelled) setDetail(d); }).catch((e) => { if (!cancelled) setError(errText(e)); });
    return () => { cancelled = true; };
  }, [selectedId, eventVersion]);

  const run = useCallback(async (fn: () => Promise<EpicDetail | void>) => {
    setBusy(true);
    setError(null);
    try {
      const d = await fn();
      if (d) { setDetail(d); setSelectedId(d.epic.id); }
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <section>
      <h1>Epics</h1>
      <form className="epics-import" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void run(async () => { const d = await api.importEpic(key.trim()); setKey(""); return d; }); }}>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Jira epic key, e.g. OPS-12" aria-label="Jira epic key" />
        <button className="btn btn-primary" type="submit" disabled={busy || !key.trim()}>{busy ? <Spinner /> : null}Import</button>
      </form>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {epics.length === 0 && !error ? <p className="muted">No epic yet. Import one by its Jira key.</p> : null}
      <ul className="epics-list">
        {epics.map((e) => (
          <li key={e.id}>
            <button type="button" aria-current={e.id === selectedId} onClick={() => setSelectedId(e.id)}>
              <strong>{e.jira_key}</strong> {e.title}<br /><span className="muted">{summaryText(e.summary)}</span>
            </button>
          </li>
        ))}
      </ul>
      {detail ? (
        <article aria-label={`Epic ${detail.epic.jira_key}`}>
          <div className="epic-head">
            <h2>{detail.epic.jira_key} · {detail.epic.title}</h2>
            <button className="btn" type="button" disabled={busy} onClick={() => void run(() => api.syncEpic(detail.epic.id))}>Resync from Jira</button>
          </div>
          <label className="epic-summary" htmlFor="epic-progress">{summaryText(detail.summary)}</label>
          <progress id="epic-progress" className="epic-progress" value={detail.summary.merged} max={Math.max(detail.summary.total, 1)} />
          {detail.epic.error ? <p className="inline-error" role="alert">{detail.epic.error}. Nothing in the cycle can be launched.</p> : null}
          <ol className="epic-tasks">
            {detail.views.map((v) => (
              <li key={v.task.id} className="epic-task" data-state={v.state}>
                <div className="epic-task-line">
                  <span className="epic-task-title">{v.task.title}</span>
                  <span className={STATE_BADGE[v.state]}>{STATE_LABEL[v.state]}</span>
                  {v.testable ? <span className="badge badge-ready">testable</span> : null}
                  <select
                    aria-label={`Repository of ${v.task.jira_key ?? v.task.title}`}
                    value={v.task.repo_path}
                    disabled={v.task.status !== "open"}
                    onChange={(e) => void run(async () => { await api.patchTask(v.task.id, { repo_path: e.target.value }); })}
                  >
                    <option value="">Pick a repository…</option>
                    {repos.map((r) => <option key={r.id} value={r.path}>{r.name}</option>)}
                  </select>
                </div>
                {v.blockers.length ? (
                  <div className="epic-task-sub">
                    Blocked by {v.blockers.map((b) => `${b.key}${b.satisfied ? " ✓" : ""}`).join(", ")}
                    {v.stack_on ? ` · stacks on ${v.stack_on}` : ""}
                  </div>
                ) : null}
                {v.alert ? <div className="inline-error" role="alert">{v.alert}</div> : null}
              </li>
            ))}
          </ol>
        </article>
      ) : null}
    </section>
  );
}
