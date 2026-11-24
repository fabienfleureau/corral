// Epics: a Jira epic as an ordered list of tasks, with what blocks each one and
// how far the whole thing got. Jira owns the structure; resync pulls it again.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { EpicAgentPanel } from "../EpicAgentPanel";
import { favoritesFor, repoContext } from "../favorite-context";
import type { Epic, EpicDetail, EpicSummary, EpicTaskState, EpicTaskView, Favorite, Repo, Task } from "../types";
import { Spinner } from "../ui";
import { errText } from "../util";

type BoardEpicTaskState = Exclude<EpicTaskState, "killed">;

const STATE_LABEL: Record<BoardEpicTaskState, string> = {
  out: "left the epic",
  merged: "merged",
  pr_ready: "PR ready",
  pr_open: "PR open",
  running: "running",
  ready: "ready to launch",
  blocked: "blocked",
};

const STATE_BADGE: Record<BoardEpicTaskState, string> = {
  out: "badge",
  merged: "badge badge-ready",
  pr_ready: "badge badge-ready",
  pr_open: "badge badge-wait",
  running: "badge badge-mine",
  ready: "badge badge-ready",
  blocked: "badge badge-wait",
};

// Read the board left to right: what is stuck first, what shipped last.
// Killed Jira tickets stay terminal in the graph, but are omitted from the board.
const GROUP_ORDER: BoardEpicTaskState[] = ["blocked", "ready", "running", "pr_open", "pr_ready", "merged", "out"];

export function epicBoardGroups(views: EpicTaskView[]): { state: BoardEpicTaskState; label: string; views: EpicTaskView[] }[] {
  return GROUP_ORDER
    .map((state) => ({ state, label: STATE_LABEL[state], views: views.filter((view) => view.state === state) }))
    .filter((group) => group.views.length > 0);
}

export function summaryText(s: EpicSummary): string {
  if (!s || typeof s.total !== "number") return "";
  const parts = [`${s.merged}/${s.total} merged`, `${s.testable} testable`];
  if (s.ready) parts.push(`${s.ready} ready to launch`);
  if (s.blocked) parts.push(`${s.blocked} blocked`);
  return parts.join(" · ");
}

export function favoriteConfSummary(f: Pick<Favorite, "harness" | "agent" | "model" | "reasoning" | "review">): string {
  return [
    f.harness,
    f.agent,
    f.model || "smart-route",
    f.reasoning,
    f.review ? `review: ${f.review}` : "",
  ].filter(Boolean).join(" · ");
}

export function epicTaskConf(
  task: Pick<Task, "repo_path" | "target" | "agent" | "model" | "reasoning" | "review">,
  epicFavorite: Favorite | null,
  repos: Pick<Repo, "path" | "context">[],
): {
  target: string;
  agent: string | null;
  model: string | null;
  reasoning: string | null;
  review: string | null;
  inherited: boolean;
  favoriteName?: string;
} | null {
  if (task.target) {
    return {
      target: task.target,
      agent: task.agent ?? null,
      model: task.model ?? null,
      reasoning: task.reasoning ?? null,
      review: task.review ?? null,
      inherited: false,
    };
  }
  if (!epicFavorite) return null;
  const compatible = !task.repo_path.trim() ||
    (repoContext(repos, task.repo_path) ?? "professional") === (epicFavorite.context ?? "professional");
  if (!compatible) return null;
  return {
    target: epicFavorite.harness,
    agent: epicFavorite.agent || null,
    model: epicFavorite.model || null,
    reasoning: epicFavorite.reasoning || null,
    review: epicFavorite.review || null,
    inherited: true,
    favoriteName: epicFavorite.name,
  };
}

export function reconcileSelectedEpic(currentId: string | null, rows: readonly Pick<Epic, "id">[]): string | null {
  if (currentId && rows.some((r) => r.id === currentId)) return currentId;
  return rows[0]?.id ?? null;
}

export function nextSelectedEpicAfterRemove(rows: readonly Pick<Epic, "id">[], removedId: string): string | null {
  const index = rows.findIndex((r) => r.id === removedId);
  if (index === -1) return rows[0]?.id ?? null;
  return rows[index + 1]?.id ?? rows[index - 1]?.id ?? null;
}

function RemoveEpicDialog({
  epic,
  agentRunState,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  epic: Epic;
  agentRunState: string | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingId = useId();
  const descId = useId();
  const agentActive = agentRunState === "starting" || agentRunState === "running" || agentRunState === "blocked";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby={headingId}
      aria-describedby={descId}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      onClose={onClose}
    >
      <div className="history-head">
        <h1 id={headingId} className="history-title">Remove {epic.jira_key} from Corral?</h1>
      </div>
      <div id={descId} className="confirm-dialog-body">
        <p>
          Removes <strong>{epic.jira_key} · {epic.title}</strong>, its saved design history, proposed
          amendments, and autonomous agent settings/report from Corral.
        </p>
        <p className="muted">
          Nothing is changed in Jira. Existing Corral tasks stay on the Tasks page, detached from this epic,
          and you can re-import it by its Jira key later.
        </p>
        {agentActive ? (
          <p className="muted">
            Its autonomous epic agent is currently active; its schedule and stored run state will be removed.
          </p>
        ) : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
      </div>
      <div className="form-foot confirm-dialog-foot">
        <button type="button" className="btn" autoFocus disabled={busy} onClick={() => dialogRef.current?.close()}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger-solid" disabled={busy} onClick={onConfirm}>
          {busy ? <Spinner /> : null}
          {busy ? "Removing…" : "Remove epic"}
        </button>
      </div>
    </dialog>
  );
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
  const [favoriteStatus, setFavoriteStatus] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listEpics().then((rows) => { if (!cancelled) { setEpics(rows); setSelectedId((id) => reconcileSelectedEpic(id, rows)); } }).catch((e) => { if (!cancelled) setError(errText(e)); });
    api.listRepos().then((rows) => { if (!cancelled) setRepos(rows); }).catch(() => undefined);
    api.getConfig().then((cfg) => { if (!cancelled) setFavorites(cfg.favorites ?? []); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [eventVersion]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    const load = () => api.getEpic(selectedId).then((d) => { if (!cancelled) setDetail(d); }).catch((e) => { if (!cancelled) setError(errText(e)); });
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedId, eventVersion]);

  // A different epic brings its own saved favorite and working directory.
  useEffect(() => {
    if (!detail) return;
    setFavorite(detail.epic.favorite_name ?? "");
    setFavoriteStatus("");
    setRepoPath(detail.epic.repo_path ?? "");
    setRequest("");
    setCreatedTask(null);
    setConfirmRemove(false);
    setRemoveError(null);
  }, [detail?.epic.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const savedFavoriteName = detail?.epic.favorite_name ?? "";
  const savedFavorite = favorites.find((f) => f.name === savedFavoriteName) ?? null;
  const effectiveContext = repoPath.trim() ? (repoContext(repos, repoPath.trim()) ?? "professional") : null;
  const shownFavorites = favoritesFor(favorites, effectiveContext);
  const hasMultipleContexts = new Set(favorites.map((f) => f.context ?? "professional")).size > 1;
  const requestFavorite = savedFavorite && (!effectiveContext || (savedFavorite.context ?? "professional") === effectiveContext)
    ? savedFavorite
    : null;

  // The folder is typed, not picked: save it when the field is left, not on
  // every keystroke. Changing the folder alone does not overwrite open tasks.
  const changeRepo = (path: string) => {
    setRepoPath(path);
  };

  const saveRepo = () => {
    const path = repoPath.trim();
    setRepoPath(path);
    if (!detail || path === (detail.epic.repo_path ?? "")) return;
    setCreatedTask(null);
    void api.patchEpicSettings(detail.epic.id, { repo_path: path })
      .then((d) => {
        setDetail(d);
        setFavorite(d.epic.favorite_name ?? "");
        refresh();
      })
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

  const applyFavorite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setCreatedTask(null);
    setFavoriteStatus("");
    void run(async () => {
      const d = await api.patchEpicSettings(detail.epic.id, { favorite_name: favorite });
      setFavorite(d.epic.favorite_name ?? "");
      if (!d.epic.favorite_name) {
        setFavoriteStatus("Epic favorite cleared.");
      } else if (d.applied_tasks) {
        setFavoriteStatus(`Favorite saved and applied to ${d.applied_tasks} open task${d.applied_tasks === 1 ? "" : "s"}.`);
      } else {
        setFavoriteStatus("Favorite saved. New tasks on this epic will run with this conf.");
      }
      return d;
    });
  };

  // Launching is explicit: a task whose blockers cleared stays on this page
  // until the human starts it. Without an effective harness or repo, send them to its form.
  const launch = (task: Task, epicId: string, canLaunch: boolean) => {
    if (!canLaunch) {
      window.location.hash = `/tasks?task=${encodeURIComponent(task.id)}`;
      return;
    }
    setLaunchingId(task.id);
    void run(async () => { await api.launchEpicTask(epicId, task.id); }).finally(() => setLaunchingId(null));
  };

  const removeEpic = async () => {
    if (!detail) return;
    const removedId = detail.epic.id;
    setRemoving(true);
    setRemoveError(null);
    try {
      await api.deleteEpic(removedId);
      const nextId = nextSelectedEpicAfterRemove(epics, removedId);
      setEpics((rows) => rows.filter((r) => r.id !== removedId));
      setSelectedId(nextId);
      setDetail(null);
      setConfirmRemove(false);
      setCreatedTask(null);
      setError(null);
      refresh();
    } catch (e) {
      setRemoveError(errText(e));
    } finally {
      setRemoving(false);
    }
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
              <strong>{e.jira_key}</strong> {e.title}{e.favorite_name ? <> <span className="badge">{e.favorite_name}</span></> : null}<br /><span className="muted">{summaryText(e.summary)}</span>
            </button>
          </li>
        ))}
      </ul>
      {detail ? (
        <article aria-label={`Epic ${detail.epic.jira_key}`}>
          {detail.error ? <p className="inline-error" role="alert">{detail.error}. Restart the Corral server, then reload.</p> : null}
          <div className="epic-head">
            <h2>{detail.epic.jira_key} · {detail.epic.title}</h2>
            <div className="epic-head-actions">
              <button className="btn" type="button" disabled={busy || removing} onClick={() => void run(() => api.syncEpic(detail.epic.id))}>Resync from Jira</button>
              <button
                className="btn btn-danger"
                type="button"
                aria-haspopup="dialog"
                disabled={busy || removing}
                onClick={() => { setRemoveError(null); setConfirmRemove(true); }}
              >
                Remove
              </button>
            </div>
          </div>
          <label className="epic-summary" htmlFor="epic-progress">{summaryText(detail.summary)}</label>
          <progress id="epic-progress" className="epic-progress" value={detail.summary.merged} max={Math.max(detail.summary.total, 1)} />
          {detail.epic.error ? <p className="inline-error" role="alert">{detail.epic.error}. Nothing in the cycle can be launched.</p> : null}
          <section className="epic-favorite">
            <div className="epic-favorite-head">
              <h3 id="epic-favorite-title">Task favorite</h3>
              <div className="epic-favorite-conf">
                {savedFavorite ? (
                  <>
                    <span className="badge badge-target">{savedFavorite.harness}</span>
                    {savedFavorite.agent ? <span className="badge">{savedFavorite.agent}</span> : null}
                    <span className="badge">{savedFavorite.model || "smart-route"}</span>
                    {savedFavorite.reasoning ? <span className="badge">{savedFavorite.reasoning}</span> : null}
                    {savedFavorite.review ? <span className="badge">review: {savedFavorite.review}</span> : null}
                  </>
                ) : savedFavoriteName ? (
                  <span className="badge badge-wait">{savedFavoriteName} (missing from Settings)</span>
                ) : (
                  <span className="muted">No favorite assigned</span>
                )}
              </div>
            </div>
            <form className="epic-favorite-form" aria-labelledby="epic-favorite-title" onSubmit={applyFavorite}>
              <label htmlFor="epic-favorite-select">Favorite</label>
              <div className="epic-favorite-controls">
                <select
                  id="epic-favorite-select"
                  name="favorite_name"
                  value={favorite}
                  disabled={busy}
                  aria-describedby="epic-favorite-help"
                  onChange={(e) => { setFavorite(e.target.value); setFavoriteStatus(""); }}
                >
                  <option value="">No favorite — pick conf per task</option>
                  {favorite && !shownFavorites.some((f) => f.name === favorite) ? (
                    <option value={favorite}>{favorite} (unavailable)</option>
                  ) : null}
                  {shownFavorites.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name} — {favoriteConfSummary(f)}{effectiveContext === null && hasMultipleContexts ? ` (${f.context ?? "professional"})` : ""}
                    </option>
                  ))}
                </select>
                <button className="btn btn-primary" type="submit" disabled={busy || favorite === savedFavoriteName}>
                  {busy ? <Spinner /> : null}
                  Apply
                </button>
              </div>
              <small className="muted epic-request-help">
                <span id="epic-favorite-help">Tasks created or launched on this epic run with this conf (compatible open tasks update when applied).</span>
                {favorites.length === 0 ? <> Add one in <a href="#/settings">Settings</a>.</> : null}
              </small>
              {favoriteStatus ? <p className="epic-favorite-status muted" role="status">{favoriteStatus}</p> : null}
            </form>
          </section>
          {detail.agent ? (
            <EpicAgentPanel
              epicKey={detail.epic.jira_key}
              view={detail.agent}
              repos={repos}
              favorites={favorites}
              onUpdate={(agent) => {
                setDetail((previous) => (previous && previous.epic.id === agent.epicId ? { ...previous, agent } : previous));
                refresh();
              }}
            />
          ) : null}
          <p className="muted">Ready tasks wait here until you launch them. Nothing is added to the inbox on its own.</p>
          <section className="epic-request" aria-labelledby="epic-request-title">
            <h3 id="epic-request-title">Ask about this epic</h3>
            <p className="muted" id="epic-request-help">
              Ask a question, request a change to the epic or its design, act on an existing task, or create epic or classic Corral tasks.
              Corral creates a task that determines your intent and can interact with this epic and your tasks.
            </p>
            <form aria-labelledby="epic-request-title" onSubmit={(e) => {
              e.preventDefault();
              const text = request.trim();
              if (!text) return;
              const path = repoPath.trim();
              void run(async () => {
                const task = await api.createEpicRequest(detail.epic.id, { request: text, favorite_name: requestFavorite?.name ?? "", repo_path: path });
                setRequest("");
                setCreatedTask(task);
              });
            }}>
              <label htmlFor="epic-request-text">What needs to happen?</label>
              <textarea
                id="epic-request-text"
                name="request"
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                rows={3}
                maxLength={8000}
                placeholder="Ask a question, change the epic or design, act on a task, or create new tasks…"
                aria-describedby="epic-request-help"
                required
              />
              <div className="epic-request-choices">
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
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                  <datalist id="epic-request-repos">
                    {repos.map((r) => <option key={r.id} value={r.path}>{r.name}</option>)}
                  </datalist>
                  <small id="epic-request-repo-help" className="muted epic-request-help">Any folder path works. Registered repositories are suggested.</small>
                </div>
              </div>
              <p className="muted epic-request-help">
                {requestFavorite ? (
                  <>Runs with epic favorite <strong>{requestFavorite.name}</strong> ({favoriteConfSummary(requestFavorite)}).</>
                ) : savedFavorite ? (
                  <>Epic favorite <strong>{savedFavorite.name}</strong> does not match this folder&apos;s context; pick conf on the created task.</>
                ) : (
                  <>No epic favorite assigned; pick conf on the created task.</>
                )}
              </p>
              <div className="epic-request-actions">
                <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? <Spinner /> : null}Create task</button>
              </div>
            </form>
            {createdTask ? <p className="epic-request-created" role="status">Task created: <a href={`#/tasks?task=${encodeURIComponent(createdTask.id)}`}>{createdTask.title}</a></p> : null}
          </section>
          <div className="epic-groups">
            {epicBoardGroups(detail.views).map(({ state, label, views }) => (
              <section key={state} className="epic-group" aria-label={label}>
                <h3>{label} <span>{views.length}</span></h3>
                <ul className="epic-tasks">
            {views.map((v) => {
              const conf = epicTaskConf(v.task, savedFavorite, repos);
              const canLaunch = Boolean(conf?.target && v.task.repo_path);
              return (
              <li key={v.task.id} className="epic-task" data-state={state}>
                <div className="epic-task-line">
                  <h4 className="epic-task-title">
                    {v.task.jira_url ? (
                      <a className="card-link" href={v.task.jira_url} target="_blank" rel="noopener noreferrer" title={`Open ${v.task.jira_key ?? "Jira ticket"} in Jira`}>{v.task.title}</a>
                    ) : (
                      <a className="card-link" href={`#/tasks?task=${encodeURIComponent(v.task.id)}`} title="Open this task">{v.task.title}</a>
                    )}
                  </h4>
                  <span className={STATE_BADGE[state]}>{label}</span>
                  {v.testable ? <span className="badge badge-ready">testable</span> : null}
                  {v.impacted ? <span className="badge badge-wait" title="Started on an older design and not merged yet">impacted by design change</span> : null}
                  {v.state === "ready" && !detail.epic.error ? (
                    <button
                      className="btn btn-primary"
                      type="button"
                      aria-label={`Launch ${v.task.jira_key ?? v.task.title}`}
                      title={canLaunch
                        ? (conf?.inherited ? `Start using epic favorite ${conf.favoriteName}` : "Start the agent on this task")
                        : v.task.repo_path
                          ? "Assign an epic favorite or pick a harness on the task first"
                          : "Pick a repository on the task first"}
                      disabled={busy || launchingId !== null}
                      onClick={() => launch(v.task, detail.epic.id, canLaunch)}
                    >
                      {launchingId === v.task.id ? <Spinner /> : null}
                      {canLaunch ? "Launch" : "Configure"}
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
                {conf ? (
                  <div className="epic-task-sub epic-task-conf">
                    {conf.inherited ? `Epic favorite (${conf.favoriteName}): ` : ""}
                    {favoriteConfSummary({
                      harness: conf.target,
                      agent: conf.agent ?? "",
                      model: conf.model ?? "",
                      reasoning: conf.reasoning ?? "",
                      review: conf.review ?? "",
                    })}
                  </div>
                ) : null}
                {v.blockers.length ? (
                  <div className="epic-task-sub">
                    Blocked by {v.blockers.map((b) => `${b.key}${b.satisfied ? " ✓" : ""}`).join(", ")}
                    {v.stack_on ? ` · stacks on ${v.stack_on}` : ""}
                  </div>
                ) : null}
                {v.alert ? <div className="inline-error" role="alert">{v.alert}</div> : null}
              </li>
              );
            })}
                </ul>
              </section>
            ))}
          </div>
          <section aria-labelledby="epic-design-title" className="epic-design">
            <h3 id="epic-design-title">Design v{detail.design?.version ?? 1}</h3>
            {detail.design?.body ? <p className="epic-design-body">{detail.design.body}</p> : <p className="muted">No design text yet.</p>}
            {detail.amendments.length ? <p className="muted">{detail.amendments.length} amendment{detail.amendments.length > 1 ? "s" : ""} waiting in the inbox.</p> : null}
            <p className="muted">The current design and its amendments stay on the epic. Ask for a change with the request field above.</p>
          </section>
        </article>
      ) : null}
      {confirmRemove && detail ? (
        <RemoveEpicDialog
          epic={detail.epic}
          agentRunState={detail.agent?.runState ?? null}
          busy={removing}
          error={removeError}
          onConfirm={() => void removeEpic()}
          onClose={() => { if (!removing) { setConfirmRemove(false); setRemoveError(null); } }}
        />
      ) : null}
    </section>
  );
}
