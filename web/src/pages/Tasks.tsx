// Tasks — dispatch queue grouped by Jira parent.

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import type { DispatchResult, NewTaskInput } from "../api";
import type { JiraSearchResult, Task } from "../types";
import { errText, formatTs, timeAgo } from "../util";
import { Chevron, ExternalLinkIcon, Spinner } from "../ui";

const TARGET_OPTIONS = ["claude", "codex", "opencode"];

export function TasksPage({ eventVersion, refresh }: { eventVersion: number; refresh: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listTasks()
      .then((list) => {
        if (!cancelled) {
          setTasks(list);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventVersion]);

  const groups = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) {
      const key = t.jira_parent_key ?? "";
      const arr = map.get(key);
      if (arr) arr.push(t);
      else map.set(key, [t]);
    }
    const named = [...map.entries()].filter(([key]) => key !== "").sort(([a], [b]) => a.localeCompare(b));
    return { named, ungrouped: map.get("") ?? [] };
  }, [tasks]);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderGroup = (key: string, members: Task[], label: ReactNode, href: string | null) => {
    const open = !collapsed.has(key);
    return (
      <section className="task-group" key={key || "ungrouped"}>
        <div
          className="task-group-head"
          role="button"
          tabIndex={0}
          onClick={() => toggleGroup(key)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") toggleGroup(key);
          }}
        >
          <Chevron open={open} />
          <span className="task-group-title">{label}</span>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="meta-link"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLinkIcon />
            </a>
          ) : null}
          <span className="badge">{members.length}</span>
        </div>
        {open ? (
          <div className="task-group-body">
            {members.map((task) => (
              <TaskRow key={task.id} task={task} refresh={refresh} />
            ))}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <div className="page tasks-page">
      <div className="page-scroll">
        <div className="page-toolbar">
          <h1 className="page-title">Tasks</h1>
          <div className="toolbar-actions">
            <button className="btn" onClick={() => setShowImport((v) => !v)}>
              {showImport ? "Close import" : "Import from Jira"}
            </button>
            <button className="btn btn-primary" onClick={() => setShowNew((v) => !v)}>
              {showNew ? "Close" : "New task"}
            </button>
          </div>
        </div>

        {showImport ? <JiraImport onDone={() => { setShowImport(false); refresh(); }} /> : null}
        {showNew ? <NewTaskForm onDone={() => { setShowNew(false); refresh(); }} /> : null}

        {error ? <div className="inline-error">{error}</div> : null}
        {loading && tasks.length === 0 ? (
          <div className="pane-note">
            <Spinner label="Loading…" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="pane-note">No tasks yet. Create one or import from Jira.</div>
        ) : (
          <div className="task-groups">
            {groups.named.map(([key, members]) =>
              renderGroup(key, members, key, parentUrl(members, key)),
            )}
            {groups.ungrouped.length > 0
              ? renderGroup("ungrouped", groups.ungrouped, "Ungrouped", null)
              : null}
          </div>
        )}
      </div>
    </div>
  );
}

function parentUrl(members: Task[], parentKey: string): string | null {
  for (const m of members) {
    if (m.jira_url && m.jira_key && m.jira_url.includes(m.jira_key)) {
      return m.jira_url.replace(m.jira_key, parentKey);
    }
  }
  return null;
}

// ---- one task row ----

function TaskRow({ task, refresh }: { task: Task; refresh: () => void }) {
  const [showDispatch, setShowDispatch] = useState(false);
  const [target, setTarget] = useState(task.target || "claude");
  const [useWorktree, setUseWorktree] = useState(true);
  const [dispatchResult, setDispatchResult] = useState<DispatchResult | null>(null);
  const [showComment, setShowComment] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>, okMsg?: string) => {
    if (busy) return;
    setBusy(label);
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
      refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const dispatch = async () => {
    if (busy) return;
    setBusy("dispatch");
    setError(null);
    setMsg(null);
    try {
      const result = await api.dispatchTask(task.id, { target, use_worktree: useWorktree });
      setDispatchResult(result);
      setShowDispatch(false);
      refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const submitComment = async () => {
    if (!commentText.trim()) return;
    await run("comment", () => api.jiraComment(task.id, commentText), "Comment added.");
    setCommentText("");
    setShowComment(false);
  };

  return (
    <div className="task-row">
      <div className="task-main">
        <div className="task-title">
          <span>{task.title}</span>
          {task.jira_key && task.jira_url ? (
            <a href={task.jira_url} target="_blank" rel="noreferrer" className="meta-link" title={task.jira_url}>
              {task.jira_key}
              <ExternalLinkIcon />
            </a>
          ) : null}
        </div>
        <div className="task-sub">
          <span className={`badge status-${task.status}`}>{task.status}</span>
          <span className={`badge badge-target ${task.target ? "" : "badge-mute"}`}>
            {task.target || "target: suggested"}
          </span>
          {task.target && task.target_state === "suggested" ? <span className="muted">(suggested)</span> : null}
          {task.branch ? <span className="mono">{task.branch}</span> : null}
          {task.repo_path ? <span className="mono muted">{task.repo_path}</span> : null}
          <span className="time muted" title={formatTs(task.updated_ms)}>
            {timeAgo(task.updated_ms)}
          </span>
        </div>
        {task.worktree_path ? <div className="task-sub mono muted">worktree: {task.worktree_path}</div> : null}
        {dispatchResult ? (
          <div className="task-sub">
            <span className="inline-ok">Dispatched</span>
            <span className="mono">branch: {dispatchResult.branch}</span>
            <span className="mono">terminal: {dispatchResult.address}</span>
          </div>
        ) : null}
        {msg ? <div className="inline-ok">{msg}</div> : null}
        {error ? <div className="inline-error">{error}</div> : null}

        {showDispatch ? (
          <div className="inline-form">
            <label className="field-inline">
              <span>Target</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {TARGET_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="check-inline">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => setUseWorktree(e.target.checked)}
              />
              <span>Create worktree</span>
            </label>
            <button className="btn btn-primary" onClick={() => void dispatch()} disabled={busy !== null}>
              {busy === "dispatch" ? <Spinner /> : null}
              {busy === "dispatch" ? "Dispatching…" : "Dispatch"}
            </button>
            <button className="btn" onClick={() => setShowDispatch(false)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        ) : null}

        {showComment ? (
          <div className="inline-form">
            <textarea
              className="comment-input"
              rows={2}
              placeholder="Comment for the Jira issue…"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
            />
            <div className="inline-form-foot">
              <button className="btn btn-primary" onClick={() => void submitComment()} disabled={busy !== null || !commentText.trim()}>
                {busy === "comment" ? <Spinner /> : null}
                Comment
              </button>
              <button className="btn" onClick={() => setShowComment(false)} disabled={busy !== null}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="task-actions">
        <button
          className="btn"
          onClick={() => setShowDispatch((v) => !v)}
          disabled={task.status === "dispatched" || busy !== null}
          title={task.status === "dispatched" ? "Already dispatched" : undefined}
        >
          {task.status === "dispatched" ? "Dispatched" : "Dispatch"}
        </button>
        {task.jira_key ? (
          <>
            <button
              className="btn"
              onClick={() => void run("done", () => api.jiraDone(task.id), "Marked done in Jira.")}
              disabled={busy !== null}
            >
              {busy === "done" ? "Working…" : "Mark done"}
            </button>
            <button className="btn" onClick={() => setShowComment((v) => !v)} disabled={busy !== null}>
              Add comment
            </button>
          </>
        ) : null}
        {task.worktree_path && (task.status === "done" || task.status === "archived") ? (
          <button
            className="btn"
            onClick={() => void run("cleanup", () => api.cleanupTask(task.id), "Worktree removed.")}
            disabled={busy !== null}
          >
            {busy === "cleanup" ? "Cleaning…" : "Cleanup worktree"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---- new task form ----

function NewTaskForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [target, setTarget] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input: NewTaskInput = {
        title: title.trim(),
        prompt,
        repo_path: repoPath.trim(),
        target,
        base_branch: baseBranch.trim() || null,
      };
      await api.createTask(input);
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel-form">
      <h2 className="panel-title">New task</h2>
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should the agent do?" />
      </label>
      <label className="field">
        <span>Prompt</span>
        <textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Extra context for the agent…"
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Repo path</span>
          <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/path/to/repo" />
        </label>
        <label className="field">
          <span>Target</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">suggested</option>
            {TARGET_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Base branch (optional)</span>
          <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
        </label>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="form-foot">
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !title.trim()}>
          {busy ? <Spinner /> : null}
          {busy ? "Creating…" : "Create task"}
        </button>
        <button className="btn" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---- jira import ----

function JiraImport({ onDone }: { onDone: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<JiraSearchResult[] | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"search" | "import" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (busy) return;
    setBusy("search");
    setError(null);
    setMsg(null);
    try {
      setResults(await api.jiraSearch(q));
      setSelectedKeys(new Set());
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const importSelected = async () => {
    if (busy || selectedKeys.size === 0) return;
    setBusy("import");
    setError(null);
    setMsg(null);
    try {
      const created = await api.jiraImport([...selectedKeys]);
      setMsg(`Imported ${created.length} task${created.length === 1 ? "" : "s"}.`);
      setResults(null);
      setSelectedKeys(new Set());
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel-form">
      <h2 className="panel-title">Import from Jira</h2>
      <div className="search-row">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Text or JQL…"
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
        />
        <button className="btn" onClick={() => void search()} disabled={busy !== null || !q.trim()}>
          {busy === "search" ? <Spinner /> : null}
          Search
        </button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {msg ? <div className="inline-ok">{msg}</div> : null}
      {results !== null ? (
        results.length === 0 ? (
          <div className="pane-note">No issues found.</div>
        ) : (
          <>
            <div className="import-list">
              {results.map((r) => (
                <label className="import-row" key={r.jira_key}>
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(r.jira_key)}
                    onChange={() => toggleKey(r.jira_key)}
                  />
                  <span className="import-title">{r.title}</span>
                  <a href={r.jira_url} target="_blank" rel="noreferrer" className="meta-link">
                    {r.jira_key}
                    <ExternalLinkIcon />
                  </a>
                  {r.jira_parent_key ? <span className="badge">{r.jira_parent_key}</span> : null}
                </label>
              ))}
            </div>
            <div className="form-foot">
              <button
                className="btn btn-primary"
                onClick={() => void importSelected()}
                disabled={busy !== null || selectedKeys.size === 0}
              >
                {busy === "import" ? <Spinner /> : null}
                Import selected ({selectedKeys.size})
              </button>
              <button className="btn" onClick={onDone} disabled={busy !== null}>
                Close
              </button>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}
