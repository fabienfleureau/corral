// Epics: a Jira epic as an ordered list of tasks, with what blocks each one and
// how far the whole thing got. Jira owns the structure; resync pulls it again.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { favoritesFor, repoContext } from "../favorite-context";
import type { Epic, EpicDetail, EpicSummary, EpicTaskState, Favorite, Repo, Task } from "../types";
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

// Read the board left to right: what is stuck first, what shipped last.
const GROUP_ORDER: EpicTaskState[] = ["blocked", "ready", "running", "pr_open", "pr_ready", "merged", "out"];

export function summaryText(s: EpicSummary): string {
  if (!s || typeof s.total !== "number") return "";
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
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [request, setRequest] = useState("");
  const [favorite, setFavorite] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
  const [proposal, setProposal] = useState("");
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listEpics().then((rows) => { if (!cancelled) { setEpics(rows); setSelectedId((id) => id ?? rows[0]?.id ?? null); } }).catch((e) => { if (!cancelled) setError(errText(e)); });
    api.listRepos().then((rows) => { if (!cancelled) setRepos(rows); }).catch(() => undefined);
    api.getConfig().then((cfg) => { if (!cancelled) setFavorites(cfg.favorites ?? []); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [eventVersion]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    api.getEpic(selectedId).then((d) => { if (!cancelled) setDetail(d); }).catch((e) => { if (!cancelled) setError(errText(e)); });
    return () => { cancelled = true; };
  }, [selectedId, eventVersion]);

  // A different epic brings its own saved favorite and working directory.
  useEffect(() => {
    if (!detail) return;
    setFavorite(detail.epic.favorite_name ?? "");
    setRepoPath(detail.epic.repo_path ?? "");
    setRequest("");
    setCreatedTask(null);
    setProposal("");
  }, [detail?.epic.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const shownFavorites = favoritesFor(favorites, repoContext(repos, repoPath));

  const saveSettings = (nextFavorite: string, nextRepoPath: string) => {
    setCreatedTask(null);
    setProposal("");
    if (!detail) return;
    void run(() => api.patchEpicSettings(detail.epic.id, { favorite_name: nextFavorite, repo_path: nextRepoPath }));
  };

  const changeFavorite = (name: string) => {
    setFavorite(name);
    saveSettings(name, repoPath);
  };

  // The folder is typed, not picked: save it when the field is left, not on
  // every keystroke. A custom path uses the professional favorite context.
  const changeRepo = (path: string) => {
    const allowed = favoritesFor(favorites, repoContext(repos, path.trim()));
    const nextFavorite = favorite && allowed.some((f) => f.name === favorite) ? favorite : "";
    setRepoPath(path);
    setFavorite(nextFavorite);
  };

  const saveRepo = () => {
    const path = repoPath.trim();
    setRepoPath(path);
    if (!detail || (path === (detail.epic.repo_path ?? "") && favorite === (detail.epic.favorite_name ?? ""))) return;
    setCreatedTask(null);
    setProposal("");
    void api.patchEpicSettings(detail.epic.id, { favorite_name: favorite, repo_path: path })
      .then((d) => { setDetail(d); refresh(); })
      .catch((e) => setError(errText(e)));
  };

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

  // Read-only planning: the assistant sees the epic context but cannot change
  // tasks, PRs or Jira. A separate button keeps that promise deterministic.
  const plan = (form: HTMLFormElement) => {
    const field = form.elements.namedItem("request");
    if (!(field instanceof HTMLTextAreaElement) || !field.reportValidity()) return;
    const text = request.trim();
    if (!text || !detail) return;
    setPlanning(true);
    void run(async () => {
      const result = await api.orchestrateEpic(detail.epic.id, text);
      setCreatedTask(null);
      setProposal(result.proposal);
    }).finally(() => setPlanning(false));
  };

  // Launching is explicit: a task whose blockers cleared stays on this page
  // until the human starts it. Without a harness or repo, send them to its form.
  const launch = (task: Task, epicId: string) => {
    if (!task.target || !task.repo_path) {
      window.location.hash = `/tasks?task=${encodeURIComponent(task.id)}`;
      return;
    }
    setLaunchingId(task.id);
    void run(async () => { await api.launchEpicTask(epicId, task.id); }).finally(() => setLaunchingId(null));
  };

  return (
    <section className="page-scroll epics-page">
      <h1>Epics</h1>
      <form className="epics-import" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void run(async () => { const d = await api.importEpic(key.trim()); setKey(""); return d; }); }}>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Jira epic key, e.g. OPS-12" aria-label="Jira epic key" />
        <button className="btn btn-primary" type="submit" disabled={busy || !key.trim()}>{busy ? <Spinner /> : null}Import</button>
      </form>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {epics.length === 0 && detail === null && !error && !busy ? <p className="muted">No epic yet. Import one by its Jira key.</p> : null}
      <ul className="epics-list">
        {epics.map((e) => (
          <li key={e.id}>
            <button type="button" disabled={busy} aria-current={e.id === selectedId} onClick={() => setSelectedId(e.id)}>
              <strong>{e.jira_key}</strong> {e.title}<br /><span className="muted">{summaryText(e.summary)}</span>
            </button>
          </li>
        ))}
      </ul>
      {detail ? (
        <article aria-label={`Epic ${detail.epic.jira_key}`}>
          {detail.error ? <p className="inline-error" role="alert">{detail.error}. Restart the Corral server, then reload.</p> : null}
          <div className="epic-head">
            <h2>{detail.epic.jira_key} · {detail.epic.title}</h2>
            <button className="btn" type="button" disabled={busy} onClick={() => void run(() => api.syncEpic(detail.epic.id))}>Resync from Jira</button>
          </div>
          <label className="epic-summary" htmlFor="epic-progress">{summaryText(detail.summary)}</label>
          <progress id="epic-progress" className="epic-progress" value={detail.summary.merged} max={Math.max(detail.summary.total, 1)} />
          {detail.epic.error ? <p className="inline-error" role="alert">{detail.epic.error}. Nothing in the cycle can be launched.</p> : null}
          <p className="muted">Ready tasks wait here until you launch them. Nothing is added to the inbox on its own.</p>
          <section className="epic-request" aria-labelledby="epic-request-title">
            <h3 id="epic-request-title">Ask about this epic</h3>
            <p className="muted" id="epic-request-help">
              One request, two actions. <strong>Propose a plan</strong> only reads the epic: no task, no PR, no Jira change.
              <strong> Create task</strong> tracks the work for later dispatch and can lead to code, PRs and design changes.
            </p>
            <form aria-labelledby="epic-request-title" onSubmit={(e) => {
              e.preventDefault();
              const text = request.trim();
              if (!text) return;
              const path = repoPath.trim();
              const allowed = favoritesFor(favorites, repoContext(repos, path));
              const chosenFavorite = favorite && allowed.some((f) => f.name === favorite) ? favorite : "";
              void run(async () => {
                const task = await api.createEpicRequest(detail.epic.id, { request: text, favorite_name: chosenFavorite, repo_path: path });
                setRequest("");
                setProposal("");
                setCreatedTask(task);
              });
            }}>
              <label htmlFor="epic-request-text">What needs to happen?</label>
              <textarea id="epic-request-text" name="request" value={request} onChange={(e) => setRequest(e.target.value)} rows={3} maxLength={8000} aria-describedby="epic-request-help" required />
              <div className="epic-request-choices">
                <div className="field">
                  <label htmlFor="epic-request-favorite">Favorite</label>
                  <select id="epic-request-favorite" name="favorite_name" value={favorite} disabled={busy} onChange={(e) => changeFavorite(e.target.value)}>
                    <option value="">No favorite — pick one when launching</option>
                    {shownFavorites.map((f) => <option key={f.name} value={f.name}>{f.name} — {f.harness}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="epic-request-repo">Working directory</label>
                  <input
                    id="epic-request-repo"
                    name="repo_path"
                    list="epic-request-repos"
                    value={repoPath}
                    onChange={(e) => changeRepo(e.target.value)}
                    onBlur={saveRepo}
                    placeholder="/path/to/repo"
                    aria-describedby="epic-request-repo-help"
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <datalist id="epic-request-repos">
                    {repos.map((r) => <option key={r.id} value={r.path}>{r.name}</option>)}
                  </datalist>
                  <small id="epic-request-repo-help" className="muted epic-request-help">Any folder path works. Registered repositories are suggested.</small>
                </div>
              </div>
              <div className="epic-request-actions">
                <button className="btn" type="button" disabled={busy} onClick={(e) => plan(e.currentTarget.form!)}>
                  {planning ? <Spinner /> : null}Propose a plan (no changes)
                </button>
                <button className="btn btn-primary" type="submit" disabled={busy}>{busy && !planning ? <Spinner /> : null}Create task</button>
              </div>
            </form>
            {proposal ? <div className="epic-proposal" role="status"><h4>Proposal</h4><p>{proposal}</p><p className="muted">No task, PR or Jira change was made.</p></div> : null}
            {createdTask ? <p className="epic-request-created" role="status">Task created: <a href={`#/tasks?task=${encodeURIComponent(createdTask.id)}`}>{createdTask.title}</a></p> : null}
            {favorites.length === 0 ? <p className="muted">Add a favorite in <a href="#/settings">Settings</a> to set the harness, agent and model on new tasks.</p> : null}
          </section>
          <div className="epic-groups">
            {GROUP_ORDER.map((state) => {
              const views = detail.views.filter((view) => view.state === state);
              if (!views.length) return null;
              return <section key={state} className="epic-group" aria-label={STATE_LABEL[state]}>
                <h3>{STATE_LABEL[state]} <span>{views.length}</span></h3>
                <ul className="epic-tasks">
            {views.map((v) => (
              <li key={v.task.id} className="epic-task" data-state={v.state}>
                <div className="epic-task-line">
                  <h4 className="epic-task-title">
                    {v.task.jira_url ? (
                      <a className="card-link" href={v.task.jira_url} target="_blank" rel="noopener noreferrer" title={`Open ${v.task.jira_key ?? "Jira ticket"} in Jira`}>{v.task.title}</a>
                    ) : (
                      <a className="card-link" href={`#/tasks?task=${encodeURIComponent(v.task.id)}`} title="Open this task">{v.task.title}</a>
                    )}
                  </h4>
                  <span className={STATE_BADGE[v.state]}>{STATE_LABEL[v.state]}</span>
                  {v.testable ? <span className="badge badge-ready">testable</span> : null}
                  {v.impacted ? <span className="badge badge-wait" title="Started on an older design and not merged yet">impacted by design change</span> : null}
                  {v.state === "ready" && !detail.epic.error ? (
                    <button
                      className="btn btn-primary"
                      type="button"
                      aria-label={`Launch ${v.task.jira_key ?? v.task.title}`}
                      title={v.task.target && v.task.repo_path ? "Start the agent on this task" : "Pick a harness and a repository on the task first"}
                      disabled={busy || launchingId !== null}
                      onClick={() => launch(v.task, detail.epic.id)}
                    >
                      {launchingId === v.task.id ? <Spinner /> : null}
                      {v.task.target && v.task.repo_path ? "Launch" : "Configure"}
                    </button>
                  ) : null}
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
                </ul>
              </section>;
            })}
          </div>
          <section aria-labelledby="epic-design-title" className="epic-design">
            <h3 id="epic-design-title">Design v{detail.design?.version ?? 1}</h3>
            {detail.design?.body ? <p className="epic-design-body">{detail.design.body}</p> : <p className="muted">No design text yet.</p>}
            {detail.amendments.length ? <p className="muted">{detail.amendments.length} amendment{detail.amendments.length > 1 ? "s" : ""} waiting in the inbox.</p> : null}
            <p className="muted">The current design and its amendments stay on the epic. Ask for a change with the request field above.</p>
          </section>
        </article>
      ) : null}
    </section>
  );
}
