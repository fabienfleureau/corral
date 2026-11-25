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

export function epicViewKey(v: Pick<EpicTaskView, "has_task"> & { task: Pick<Task, "id" | "jira_key"> }): string {
  return v.has_task === false ? `ticket:${v.task.jira_key ?? v.task.id}` : v.task.id;
}

export function resolveReadyLaunchConf(
  task: Pick<Task, "repo_path" | "target" | "agent" | "model" | "reasoning" | "review">,
  repoPath: string,
  pickedConf: string,
  epicFavorite: Favorite | null,
  favorites: readonly Favorite[],
  repos: readonly Pick<Repo, "path" | "context">[],
): ReturnType<typeof epicTaskConf> {
  const effectiveContext = repoPath.trim() ? (repoContext([...repos], repoPath) ?? "professional") : null;
  if (pickedConf.startsWith("fav:")) {
    const favName = pickedConf.slice(4);
    const fav = favorites.find((f) => f.name === favName) ?? null;
    if (!fav) return null;
    if (effectiveContext && (fav.context ?? "professional") !== effectiveContext) return null;
    return {
      target: fav.harness,
      agent: fav.agent || null,
      model: fav.model || null,
      reasoning: fav.reasoning || null,
      review: fav.review || null,
      inherited: false,
      favoriteName: fav.name,
    };
  }
  if (pickedConf.startsWith("target:")) {
    const target = pickedConf.slice(7);
    if (!target) return null;
    return {
      target,
      agent: task.agent ?? null,
      model: task.model ?? null,
      reasoning: task.reasoning ?? null,
      review: task.review ?? null,
      inherited: false,
    };
  }
  return epicTaskConf({ ...task, repo_path: repoPath }, epicFavorite, [...repos]);
}

export function previewStackOn(
  view: Pick<EpicTaskView, "blockers" | "stack_on">,
  allViews: readonly Pick<EpicTaskView, "has_task" | "state" | "task">[],
  repoPath: string,
): string | null {
  const trimmed = repoPath.trim();
  if (!trimmed) return null;
  const byKey = new Map(allViews.map((v) => [v.task.jira_key ?? v.task.id, v]));
  const open = view.blockers
    .map((b) => byKey.get(b.key))
    .filter((v): v is Pick<EpicTaskView, "has_task" | "state" | "task"> =>
      Boolean(v) && v!.state !== "merged" && v!.state !== "killed" && v!.state !== "out",
    );
  const sameRepo = open.filter(
    (v) => v.has_task !== false && v.task.repo_path === trimmed && Boolean(v.task.branch),
  );
  return open.length === 1 && sameRepo.length === 1 ? sameRepo[0].task.branch : null;
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
  const [agents, setAgents] = useState<string[]>([]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [draftRepos, setDraftRepos] = useState<Record<string, string>>({});
  const [draftConfs, setDraftConfs] = useState<Record<string, string>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [launchStatus, setLaunchStatus] = useState("");
  const [request, setRequest] = useState("");
  const [favorite, setFavorite] = useState("");
  const [favoriteStatus, setFavoriteStatus] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const fieldIdPrefix = useId();
  const repoSelectRefs = useRef<Record<string, HTMLSelectElement | null>>({});
  const confSelectRefs = useRef<Record<string, HTMLSelectElement | null>>({});

  useEffect(() => {
    let cancelled = false;
    api.listEpics().then((rows) => { if (!cancelled) { setEpics(rows); setSelectedId((id) => reconcileSelectedEpic(id, rows)); } }).catch((e) => { if (!cancelled) setError(errText(e)); });
    api.listRepos().then((rows) => { if (!cancelled) setRepos(rows); }).catch(() => undefined);
    api.getConfig().then((cfg) => {
      if (!cancelled) {
        setFavorites(cfg.favorites ?? []);
        setAgents(cfg.agents ?? []);
      }
    }).catch(() => undefined);
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
    setDraftRepos({});
    setDraftConfs({});
    setCardErrors({});
    setLaunchStatus("");
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
    setCardErrors({});
    setDraftConfs({});
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

  // Launching is explicit: a task or synced ticket whose blockers cleared stays on
  // this page until the human picks a repo (and conf if needed) and starts it.
  const launchReady = async (
    v: EpicTaskView,
    epicId: string,
    selectedRepo: string,
    pickedConf: string,
    effectiveConf: ReturnType<typeof epicTaskConf>,
    compatibleFavoritesCount: number,
  ) => {
    const viewKey = epicViewKey(v);
    const repoInput = selectedRepo.trim();
    if (!repoInput) {
      setCardErrors((prev) => ({ ...prev, [viewKey]: "Pick a repository first." }));
      repoSelectRefs.current[viewKey]?.focus();
      return;
    }
    if (!effectiveConf?.target) {
      setCardErrors((prev) => ({
        ...prev,
        [viewKey]: compatibleFavoritesCount > 0 ? "Pick a favorite or harness first." : "Pick a harness first.",
      }));
      confSelectRefs.current[viewKey]?.focus();
      return;
    }

    const payload: { repo_path: string; favorite?: string; target?: string } = { repo_path: repoInput };
    if (pickedConf.startsWith("fav:")) payload.favorite = pickedConf.slice(4);
    else if (pickedConf.startsWith("target:")) payload.target = pickedConf.slice(7);

    setCardErrors((prev) => {
      if (!(viewKey in prev)) return prev;
      const next = { ...prev };
      delete next[viewKey];
      return next;
    });
    setLaunchStatus("");
    setError(null);
    setLaunchingId(viewKey);
    try {
      if (v.has_task === false) {
        const jiraKey = v.task.jira_key ?? v.task.id;
        await api.launchEpicTicket(epicId, jiraKey, payload);
        setLaunchStatus(`${jiraKey} created and dispatched.`);
      } else {
        await api.launchEpicTask(epicId, v.task.id, payload);
        setLaunchStatus(`${v.task.jira_key ?? v.task.title} launched.`);
      }
      setDraftRepos((prev) => {
        if (!(viewKey in prev)) return prev;
        const next = { ...prev };
        delete next[viewKey];
        return next;
      });
      setDraftConfs((prev) => {
        if (!(viewKey in prev)) return prev;
        const next = { ...prev };
        delete next[viewKey];
        return next;
      });
      const updated = await api.getEpic(epicId);
      setDetail(updated);
      refresh();
    } catch (e) {
      setCardErrors((prev) => ({ ...prev, [viewKey]: errText(e) }));
      if (v.has_task === false) {
        api.getEpic(epicId).then((updated) => setDetail(updated)).catch(() => undefined);
      }
    } finally {
      setLaunchingId(null);
    }
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
          {launchStatus ? <p className="muted" role="status">{launchStatus}</p> : null}
          <div className="epic-groups">
            {epicBoardGroups(detail.views).map(({ state, label, views }) => (
              <section key={state} className="epic-group" aria-label={label}>
                <h3>{label} <span>{views.length}</span></h3>
                <ul className="epic-tasks">
            {views.map((v) => {
              const viewKey = epicViewKey(v);
              const isReadyCard = v.state === "ready" && !detail.epic.error;
              const selectedRepo = isReadyCard ? (draftRepos[viewKey] ?? v.task.repo_path) : v.task.repo_path;
              const pickedConf = isReadyCard ? (draftConfs[viewKey] ?? "") : "";
              const baseConf = epicTaskConf({ ...v.task, repo_path: selectedRepo }, savedFavorite, repos);
              const conf = isReadyCard
                ? resolveReadyLaunchConf(v.task, selectedRepo, pickedConf, savedFavorite, favorites, repos)
                : baseConf;
              const selectedContext = selectedRepo.trim() ? (repoContext(repos, selectedRepo) ?? "professional") : null;
              const compatibleFavorites = favoritesFor(favorites, selectedContext);
              const showConfPicker = isReadyCard && (!baseConf || Boolean(pickedConf));
              const cardError = isReadyCard ? cardErrors[viewKey] : undefined;
              const repoFieldId = `${fieldIdPrefix}-${viewKey}-repo`;
              const confFieldId = `${fieldIdPrefix}-${viewKey}-conf`;
              const errorId = `${fieldIdPrefix}-${viewKey}-err`;
              const repoMissingError = Boolean(cardError && !selectedRepo.trim());
              const confMissingError = Boolean(cardError && selectedRepo.trim() && !conf?.target);
              const stackOn = isReadyCard ? previewStackOn(v, detail.views, selectedRepo) : v.stack_on;
              const cardLabel = v.task.jira_key ?? v.task.title;
              const isLaunchingThis = launchingId === viewKey;
              return (
              <li key={viewKey} className="epic-task" data-state={state}>
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
                  {!isReadyCard && v.has_task !== false ? (
                    <select
                      aria-label={`Repository of ${cardLabel}`}
                      value={v.task.repo_path}
                      disabled={v.task.status !== "open"}
                      onChange={(e) => void run(async () => { await api.patchTask(v.task.id, { repo_path: e.target.value }); })}
                    >
                      <option value="">Pick a repository…</option>
                      {repos.map((r) => <option key={r.id} value={r.path}>{r.name}</option>)}
                    </select>
                  ) : null}
                </div>
                {isReadyCard ? (
                  <form
                    className="epic-task-launch"
                    aria-label={`Launch ${cardLabel}`}
                    noValidate
                    onSubmit={(e) => {
                      e.preventDefault();
                      void launchReady(v, detail.epic.id, selectedRepo, pickedConf, conf, compatibleFavorites.length);
                    }}
                  >
                    <div className="epic-task-field">
                      <label htmlFor={repoFieldId}>Repository</label>
                      <select
                        ref={(el) => { repoSelectRefs.current[viewKey] = el; }}
                        id={repoFieldId}
                        name="repo_path"
                        value={selectedRepo}
                        disabled={busy || launchingId !== null}
                        aria-invalid={repoMissingError ? true : undefined}
                        aria-describedby={cardError ? errorId : undefined}
                        onChange={(e) => {
                          const nextRepo = e.target.value;
                          setDraftRepos((prev) => ({ ...prev, [viewKey]: nextRepo }));
                          setCardErrors((prev) => {
                            if (!(viewKey in prev)) return prev;
                            const next = { ...prev };
                            delete next[viewKey];
                            return next;
                          });
                          if (pickedConf.startsWith("fav:") && nextRepo.trim()) {
                            const favName = pickedConf.slice(4);
                            const nextCtx = repoContext(repos, nextRepo) ?? "professional";
                            const stillCompatible = favoritesFor(favorites, nextCtx).some((f) => f.name === favName);
                            if (!stillCompatible) {
                              setDraftConfs((prev) => {
                                if (!(viewKey in prev)) return prev;
                                const next = { ...prev };
                                delete next[viewKey];
                                return next;
                              });
                            }
                          }
                        }}
                      >
                        <option value="">Pick a repository…</option>
                        {selectedRepo && !repos.some((r) => r.path === selectedRepo) ? (
                          <option value={selectedRepo}>{selectedRepo}</option>
                        ) : null}
                        {repos.map((r) => <option key={r.id} value={r.path}>{r.name}</option>)}
                      </select>
                    </div>
                    {showConfPicker ? (
                      <div className="epic-task-field">
                        <label htmlFor={confFieldId}>{compatibleFavorites.length > 0 ? "Favorite / harness" : "Harness"}</label>
                        <select
                          ref={(el) => { confSelectRefs.current[viewKey] = el; }}
                          id={confFieldId}
                          name="conf"
                          value={pickedConf}
                          disabled={busy || launchingId !== null}
                          aria-invalid={confMissingError ? true : undefined}
                          aria-describedby={cardError ? errorId : undefined}
                          onChange={(e) => {
                            const nextConf = e.target.value;
                            setDraftConfs((prev) => ({ ...prev, [viewKey]: nextConf }));
                            setCardErrors((prev) => {
                              if (!(viewKey in prev)) return prev;
                              const next = { ...prev };
                              delete next[viewKey];
                              return next;
                            });
                          }}
                        >
                          <option value="">{compatibleFavorites.length > 0 ? "Pick a favorite or harness…" : "Pick a harness…"}</option>
                          {compatibleFavorites.length > 0 ? (
                            <optgroup label="Favorites">
                              {compatibleFavorites.map((f) => (
                                <option key={f.name} value={`fav:${f.name}`}>
                                  {f.name} — {favoriteConfSummary(f)}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                          {agents.length > 0 ? (
                            <optgroup label="Harnesses">
                              {agents.map((a) => (
                                <option key={a} value={`target:${a}`}>{a}</option>
                              ))}
                            </optgroup>
                          ) : null}
                        </select>
                      </div>
                    ) : null}
                    <div className="epic-task-launch-actions">
                      <button
                        className="btn btn-primary"
                        type="submit"
                        disabled={busy || launchingId !== null}
                      >
                        {isLaunchingThis ? <Spinner /> : null}
                        {v.has_task === false
                          ? (isLaunchingThis ? "Creating & dispatching…" : "Create & dispatch")
                          : (isLaunchingThis ? "Launching…" : "Launch")}
                      </button>
                    </div>
                    {cardError ? <p id={errorId} className="inline-error epic-task-error" role="alert">{cardError}</p> : null}
                  </form>
                ) : null}
                {conf ? (
                  <div className="epic-task-sub epic-task-conf">
                    {conf.inherited ? `Epic favorite (${conf.favoriteName}): ` : conf.favoriteName ? `${conf.favoriteName}: ` : ""}
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
                    {stackOn ? ` · stacks on ${stackOn}` : ""}
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
