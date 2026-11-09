// Tasks — dispatch queue grouped by repository.

import { useEffect, useMemo, useState } from "react";
import { filterTasks, groupTasks, harnessLabel, sortRepos, lastHarnessSettings, modelChoices, reasoningChoices } from "../task-page";
import type { ModelOption } from "../task-page";
import { api } from "../api";
import type { DispatchResult, NewTaskInput } from "../api";
import type { AgentQuota, Favorite, JiraSearchResult, Repo, Task } from "../types";
import { errText, formatTs, prLabel, timeAgo } from "../util";
import { Chevron, ExternalLinkIcon, Spinner } from "../ui";

export function TasksPage({ eventVersion, refresh }: { eventVersion: number; refresh: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showDoneArchived, setShowDoneArchived] = useState(false);
  const [showImport, setShowImport] = useState(() => {
    // Deep link: #/tasks?import=1 opens the Jira import panel directly.
    const q = window.location.hash.split("?")[1] ?? "";
    return new URLSearchParams(q).get("import") === "1";
  });
  const [repos, setRepos] = useState<Repo[]>([]);
  const [catalog, setCatalog] = useState<Record<string, ModelOption[]>>({});
  const [targets, setTargets] = useState<string[]>([]);
  const [quotas, setQuotas] = useState<AgentQuota[]>([]);
  const [agentOptions, setAgentOptions] = useState<Record<string, { id: string; name: string }[]>>({});

  useEffect(() => {
    api
      .listHarnesses()
      .then((res) => {
        const list = res.harnesses.map((h) => h.harness);
        setTargets(list);
        setCatalog(Object.fromEntries(res.harnesses.map((h) => [h.harness, h.models ?? []])));
        setAgentOptions(Object.fromEntries(res.harnesses.map((h) => [h.harness, h.agents])));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.getUsage("7d").then((report) => {
        if (cancelled) return;
        setQuotas(report.quota);
        if (report.scanning) timer = setTimeout(load, 2000);
      }).catch(() => undefined);
    };
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [eventVersion]);

  useEffect(() => {
    api
      .listRepos()
      .then(setRepos)
      .catch(() => setRepos([]));
  }, [eventVersion]);

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

  const visibleTasks = useMemo(() => filterTasks(tasks, showDoneArchived), [tasks, showDoneArchived]);
  const groups = useMemo(() => groupTasks(visibleTasks), [visibleTasks]);
  const sortedRepos = useMemo(() => sortRepos(repos, tasks), [repos, tasks]);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderGroup = (key: string, members: Task[], label: string) => {
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
          <span className="badge">{members.length}</span>
        </div>
        {open ? (
          <div className="task-group-body">
            {members.map((task) => (
              <TaskRow key={task.id} task={task} repos={sortedRepos} targets={targets} quotas={quotas} agentOptions={agentOptions} catalog={catalog} refresh={refresh} />
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
          </div>
        </div>

        {showImport ? <JiraImport repos={sortedRepos} targets={targets} quotas={quotas} agentOptions={agentOptions} catalog={catalog} onImported={refresh} onClose={() => setShowImport(false)} /> : null}
        <NewTaskForm tasks={tasks} repos={sortedRepos} targets={targets} quotas={quotas} agentOptions={agentOptions} catalog={catalog} onDone={refresh} />

        <div className="task-list-controls">
            <label className="check-inline">
              <input
                type="checkbox"
                checked={showDoneArchived}
                onChange={(e) => setShowDoneArchived(e.target.checked)}
              />
              <span>Show done &amp; archived</span>
            </label>
        </div>

        {error ? <div className="inline-error">{error}</div> : null}
        {loading && tasks.length === 0 ? (
          <div className="pane-note">
            <Spinner label="Loading…" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="pane-note">No tasks yet. Create one or import from Jira.</div>
        ) : visibleTasks.length === 0 ? (
          <div className="pane-note">All tasks are done or archived. Check “Show done &amp; archived” to view them.</div>
        ) : (
          <div className="task-groups">
            {groups.map(([key, members]) =>
              renderGroup(key, members, key ? (repos.find((r) => r.path === key)?.name ?? key) : "No repository"),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- one task row ----

function TaskRow({
  task,
  repos,
  targets,
  quotas,
  agentOptions,
  catalog,
  refresh,
}: {
  task: Task;
  repos: Repo[];
  targets: string[];
  quotas: AgentQuota[];
  agentOptions: Record<string, { id: string; name: string }[]>;
  catalog: Record<string, ModelOption[]>;
  refresh: () => void;
}) {
  const [showDispatch, setShowDispatch] = useState(task.status === "open" || (task.status === "dispatched" && !task.terminal_address));
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [prompt, setPrompt] = useState(task.prompt);
  const [baseBranch, setBaseBranch] = useState(task.base_branch ?? "");
  const [target, setTarget] = useState(task.target || "claude");
  const [model, setModel] = useState(task.model ?? "");
  const [reasoning, setReasoning] = useState(task.reasoning ?? "");
  const [agent, setAgent] = useState(task.agent ?? "");
  const [useWorktree, setUseWorktree] = useState(true);
  const [dispatchResult, setDispatchResult] = useState<DispatchResult | null>(null);
  const [showComment, setShowComment] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setShowDispatch(task.status === "open" || (task.status === "dispatched" && !task.terminal_address));
  }, [task.status, task.terminal_address]);

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

  const selectedTarget = targets.includes(target) ? target : targets[0] ?? "";

  const dispatch = async () => {
    if (busy) return;
    setBusy("dispatch");
    setError(null);
    setMsg(null);
    try {
      const base = baseBranch.trim() || null;
      if (base !== task.base_branch) await api.patchTask(task.id, { base_branch: base });
      const result = await api.dispatchTask(task.id, {
        target: selectedTarget,
        use_worktree: useWorktree,
        agent: agent || null,
        model: model.trim() || null,
        reasoning: reasoning.trim() || null,
      });
      setDispatchResult(result);
      setShowDispatch(false);
      refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const savePrompt = async () => {
    if (busy) return;
    setBusy("prompt");
    setError(null);
    try {
      await api.patchTask(task.id, { prompt });
      setEditingPrompt(false);
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
          {task.title ? (
            <span>{task.title}</span>
          ) : (
            <span className="muted" title="Title comes from the agent session once dispatched">
              {firstLine(task.prompt) || "Untitled task"}
            </span>
          )}
          {task.jira_key && task.jira_url ? (
            <a href={task.jira_url} target="_blank" rel="noreferrer" className="meta-link" title={task.jira_url}>
              {task.jira_key}
              <ExternalLinkIcon />
            </a>
          ) : null}
        </div>
        <div className="task-sub">
          <span className={`badge status-${task.status}`} title={task.worktree_path ? `Worktree: ${task.worktree_path}` : undefined}>{task.status}</span>
          {task.target ? <span className="badge badge-target">{task.target}</span> : null}
          {task.terminal_address ? <>
            <span className="muted">Model: {task.session_model || "Unknown"}</span>
            <span className="muted">Reasoning: {task.session_reasoning || "Unknown"}</span>
          </> : null}
          {task.branch ? <span className="mono">{task.branch}</span> : null}
          {task.pr_url ? (
            <a href={task.pr_url} target="_blank" rel="noreferrer" className="pr-pill" title={task.pr_url}>
              {prLabel(task.pr_url)}
              <ExternalLinkIcon />
            </a>
          ) : null}
          {task.terminal_address ? (
            <button className="btn" onClick={() => void run("session", async () => {
              const result = await api.openSession(task.terminal_address!);
              if (result.url) window.open(result.url, "_blank", "noopener");
            })} disabled={busy !== null}>Open session</button>
          ) : null}
          <span className="time muted" title={formatTs(task.updated_ms)}>
            {timeAgo(task.updated_ms)}
          </span>
        </div>
        {task.status === "open" || (!task.repo_path && task.status !== "archived") ? (
          <div className="task-sub">
            <label className="field-inline">
              <span>Repo</span>
              <select
                value={task.repo_path || ""}
                onChange={(e) => {
                  const path = e.target.value;
                  if (path && path !== task.repo_path) void run("repo", () => api.patchTask(task.id, { repo_path: path }), "Repo updated.");
                }}
                disabled={busy !== null}
              >
                <option value="" disabled>{repos.length ? "assign a repo…" : "no repos registered (Settings)"}</option>
                {task.repo_path && !repos.some((r) => r.path === task.repo_path) ? (
                  <option value={task.repo_path}>{task.repo_path} (not registered)</option>
                ) : null}
                {repos.map((r) => (
                  <option key={r.id} value={r.path}>
                    {r.name} — {r.path}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
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
            {!task.repo_path ? (
              <div className="inline-error">Assign a repo before dispatching.</div>
            ) : null}
            {editingPrompt ? (
              <>
                <textarea aria-label="Task prompt" className="comment-input" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                <button className="btn" onClick={() => void savePrompt()} disabled={busy !== null}>Save prompt</button>
                <button className="btn" onClick={() => { setPrompt(task.prompt); setEditingPrompt(false); }} disabled={busy !== null}>Cancel</button>
              </>
            ) : (
              <>

                <button className="btn" onClick={() => { setPrompt(task.prompt); setEditingPrompt(true); }} disabled={busy !== null}>Modify prompt</button>
              </>
            )}
            <label className="field-inline">
              <span>Harness</span>
              <select value={selectedTarget} onChange={(e) => { setTarget(e.target.value); setAgent(""); setModel(e.target.value === task.target ? task.model ?? "" : ""); setReasoning(e.target.value === task.target ? task.reasoning ?? "" : ""); }}>
                {targets.length === 0 ? <option value="">No configured harnesses</option> : null}
                {targets.map((t) => (
                  <option key={t} value={t}>
                    {harnessLabel(t, quotas)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-inline">
              <span>Agent</span>
              <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="">— none (bare harness) —</option>
                {agent && !(agentOptions[selectedTarget] ?? []).some((a) => a.id === agent) ? <option value={agent}>{agent} (unavailable for this harness)</option> : null}
                {(agentOptions[selectedTarget] ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <ModelSettings models={catalog[selectedTarget] ?? []} model={model} reasoning={reasoning} setModel={setModel} setReasoning={setReasoning} fieldClass="field-inline" />
            <label className="field-inline">
              <span>Base branch (optional)</span>
              <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="Default branch" disabled={busy !== null} />
            </label>
            <button className="btn" onClick={() => void run("base", () => api.patchTask(task.id, { base_branch: baseBranch.trim() || null }), "Base branch saved.")} disabled={busy !== null || (baseBranch.trim() || null) === task.base_branch}>Save base branch</button>
            <label className="check-inline">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => setUseWorktree(e.target.checked)}
              />
              <span>Create worktree</span>
            </label>
            <button
              className="btn btn-primary"
              onClick={() => void dispatch()}
              disabled={busy !== null || editingPrompt || !task.repo_path || !selectedTarget || (!!agent && !(agentOptions[selectedTarget] ?? []).some((a) => a.id === agent))}
            >
              {busy === "dispatch" ? <Spinner /> : null}
              {busy === "dispatch" ? "Dispatching…" : "Dispatch"}
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
        {task.status === "open" ? <button className="btn" disabled={busy !== null} onClick={() => void run("cancel", () => api.patchTask(task.id, { status: "archived" }))}>Cancel task</button> : null}
        {task.status === "dispatched" && !!task.terminal_address ? <button
          className="btn"
          onClick={() => setShowDispatch((v) => !v)}
          disabled={busy !== null}
          title="Already dispatched"
        >
          Dispatched
        </button> : null}
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
      </div>
    </div>
  );
}

// ---- new task form ----

function firstLine(text: string): string {
  return text.trim().split("\n")[0].slice(0, 120);
}

// No title (omnigent names the session) and no target (picked at dispatch).
function NewTaskForm({ tasks, repos, targets, quotas, agentOptions, catalog, onDone }: { tasks: Task[]; repos: Repo[]; targets: string[]; quotas: AgentQuota[]; agentOptions: Record<string, { id: string; name: string }[]>; catalog: Record<string, ModelOption[]>; onDone: () => void }) {
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  useEffect(() => { api.getConfig().then((cfg) => setFavorites(cfg.favorites ?? [])).catch(() => undefined); }, []);
  const [prompt, setPrompt] = useState("");
  const [repoChoice, setRepoChoice] = useState("");
  const [target, setTarget] = useState("");
  const [agent, setAgent] = useState("");
  const [settings, setSettings] = useState<Record<string, { model: string; reasoning: string }>>({});
  const [repoTouched, setRepoTouched] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = () => {
    setPrompt("");
    setRepoPath("");
    setBaseBranch("");
    setError(null);
  };

  const selectedRepo = repoTouched ? repoChoice : (repos[0]?.path ?? "");
  const selectedTarget = targets.includes(target) ? target : targets[0] ?? "";

  const selectedSettings = settings[selectedTarget] ?? lastHarnessSettings(tasks, selectedTarget);
  const setSetting = (key: "model" | "reasoning", value: string) => setSettings((prev) => ({ ...prev, [selectedTarget]: { ...selectedSettings, [key]: value } }));

  const submit = async (dispatch: boolean) => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input: NewTaskInput = {
        prompt,
        target: selectedTarget,
        model: selectedSettings.model.trim() || null,
        reasoning: selectedSettings.reasoning.trim() || null,
        repo_path: selectedRepo === "__custom__" ? repoPath.trim() : selectedRepo,
        base_branch: baseBranch.trim() || null,
      };
      const task = await api.createTask(input);
      clear();
      onDone();
      if (dispatch) {
        try {
          await api.dispatchTask(task.id, { target: selectedTarget, use_worktree: true, agent: agent || null });
          onDone();
        } catch (err) {
          setError(`Task created, but dispatch failed: ${errText(err)}`);
        }
      }
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
        <span>Prompt</span>
        <textarea
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do?"
        />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Repo</span>
          <select value={selectedRepo} onChange={(e) => { setRepoTouched(true); setRepoChoice(e.target.value); }}>
            <option value="">{repos.length ? "choose a repo…" : "no repos yet (add in Settings)"}</option>
            {repos.map((r) => (
              <option key={r.id} value={r.path}>
                {r.name} — {r.path}
              </option>
            ))}
            <option value="__custom__">custom path…</option>
          </select>
        </label>
        {selectedRepo === "__custom__" ? (
          <label className="field">
            <span>Repo path</span>
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/path/to/repo" />
          </label>
        ) : null}
        <label className="field">
          <span>Base branch (optional)</span>
          <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
        </label>
      </div>
      {favorites.length > 0 ? <div className="field"><span>Favorites</span><div className="chip-row">{favorites.map((f, i) => <button type="button" className="chip" key={i} disabled={!targets.includes(f.harness)} title={!targets.includes(f.harness) ? "Harness unavailable" : [f.harness, f.agent || "bare harness", f.model || "default model", f.reasoning || "default reasoning"].join(" · ")} onClick={() => { setTarget(f.harness); setAgent(f.agent); setSettings((prev) => ({ ...prev, [f.harness]: { model: f.model, reasoning: f.reasoning } })); }}>{f.name}</button>)}</div></div> : null}
      <div className="field-row">
        <label className="field"><span>Harness</span><select value={selectedTarget} onChange={(e) => { setTarget(e.target.value); setAgent(""); }}>
          {targets.length === 0 ? <option value="">No configured harnesses</option> : null}
          {targets.map((t) => <option key={t} value={t}>{harnessLabel(t, quotas)}</option>)}
        </select></label>
        <label className="field"><span>Agent</span><select value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">— none (bare harness) —</option>
          {agent && !(agentOptions[selectedTarget] ?? []).some((a) => a.id === agent) ? <option value={agent}>{agent} (unavailable)</option> : null}
          {(agentOptions[selectedTarget] ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select></label>
      </div>
      <div className="field-row">
        <ModelSettings models={catalog[selectedTarget] ?? []} model={selectedSettings.model} reasoning={selectedSettings.reasoning} setModel={(value) => setSetting("model", value)} setReasoning={(value) => setSetting("reasoning", value)} fieldClass="field" />
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="form-foot">
        <button className="btn btn-primary" onClick={() => void submit(true)} disabled={busy || !prompt.trim() || !selectedTarget || (!!agent && !(agentOptions[selectedTarget] ?? []).some((a) => a.id === agent)) || !(selectedRepo === "__custom__" ? repoPath.trim() : selectedRepo)}>
          Create and dispatch
        </button>
        <button className="btn" onClick={() => void submit(false)} disabled={busy || !prompt.trim()}>
          {busy ? <Spinner /> : null}
          {busy ? "Creating…" : "Create task"}
        </button>
        <button className="btn" onClick={clear} disabled={busy}>
          Clear
        </button>
      </div>
    </div>
  );
}

// ---- jira import ----

type ImportSettings = { repo_path: string; base_branch: string; target: string; agent: string; model: string; reasoning: string };

function JiraImport({ repos, targets, quotas, agentOptions, catalog, onImported, onClose }: { repos: Repo[]; targets: string[]; quotas: AgentQuota[]; agentOptions: Record<string, { id: string; name: string }[]>; catalog: Record<string, ModelOption[]>; onImported: () => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<JiraSearchResult[] | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<"search" | "import" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [settings, setSettings] = useState<Record<string, ImportSettings>>({});

  const selected = useMemo(
    () => (results ?? []).filter((r) => selectedKeys.has(r.jira_key)),
    [results, selectedKeys],
  );

  // Prefill with the configured default JQL (Settings) so it is visible and
  // editable instead of hidden server-side behavior.
  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (!cancelled && cfg.jiraJql) setQ((prev) => prev || cfg.jiraJql);
        if (!cancelled) setFavorites(cfg.favorites ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const search = async () => {
    if (busy) return;
    setBusy("search");
    setError(null);
    setMsg(null);
    try {
      setResults(await api.jiraSearch(q));
      setSelectedKeys(new Set());
      setExpandedKeys(new Set());
      setSettings({});
      setReviewing(false);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (set: (fn: (prev: Set<string>) => Set<string>) => void, key: string) => {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const importSelected = async () => {
    if (busy || selected.length === 0) return;
    setBusy("import");
    setError(null);
    setMsg(null);
    try {
      const res = await api.jiraImport(selected.map((r) => ({ key: r.jira_key, fingerprint: r.fingerprint, ...settings[r.jira_key] })));
      const createdIds = new Map(res.created.map((t) => [t.jira_key, t.id]));
      const fresh = new Map(res.changed.map((r) => [r.jira_key, r]));
      const skipped = new Set(res.skipped);
      // Keep the list: imported rows flip to "already imported", changed rows
      // show their new content and stay selected for another review.
      setResults((prev) =>
        (prev ?? []).map((r) => {
          const id = createdIds.get(r.jira_key) ?? (skipped.has(r.jira_key) ? "existing" : null);
          return fresh.get(r.jira_key) ?? (id ? { ...r, existing_task_id: id } : r);
        }),
      );
      setSelectedKeys(new Set(fresh.keys()));
      setReviewing(fresh.size > 0);
      const notes = [
        res.skipped.length ? `${res.skipped.length} already imported` : "",
        res.failed.length ? `${res.failed.length} failed (see server log): ${res.failed.join(", ")}` : "",
      ].filter(Boolean);
      setMsg(
        `Imported ${res.created.length} of ${selected.length} task${selected.length === 1 ? "" : "s"}` +
          (notes.length ? ` · ${notes.join(" · ")}` : "") +
          ".",
      );
      if (fresh.size > 0) {
        setError(
          `${fresh.size} ticket${fresh.size === 1 ? "" : "s"} changed since you reviewed ` +
            `${fresh.size === 1 ? "it" : "them"}. Check the updated preview below and confirm again.`,
        );
      }
      if (res.created.length) onImported();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const repoBadge = (r: JiraSearchResult) =>
    r.repo_name ? (
      <span className="badge badge-target" title={r.repo_path ?? undefined}>
        → {r.repo_name}
      </span>
    ) : (
      <span className="badge badge-mute" title="No repo mapped to this Jira prefix; pick one after import">
        no repo
      </span>
    );

  return (
    <div className="panel-form">
      <h2 className="panel-title">Import from Jira</h2>
      {reviewing ? null : (
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
      )}
      {error ? <div className="inline-error">{error}</div> : null}
      {msg ? <div className="inline-ok">{msg}</div> : null}
      {results === null ? null : reviewing ? (
        <>
          <div className="muted import-summary">
            {selected.length} task{selected.length === 1 ? "" : "s"} will be created:
          </div>
          <div className="import-list">
            {selected.map((r) => {
              const values = settings[r.jira_key] ?? { repo_path: r.repo_path ?? "", base_branch: "", target: "", agent: "", model: "", reasoning: "" };
              const update = (patch: Partial<ImportSettings>) => setSettings((prev) => ({ ...prev, [r.jira_key]: { ...values, ...patch } }));
              return (
              <div className="import-review" key={r.jira_key}>
                <div className="import-row-head">
                  <span className="import-title">{r.title}</span>
                  {r.jira_status ? <span className="badge">{r.jira_status}</span> : null}
                  {repoBadge(r)}
                </div>
                <pre className="import-prompt">{r.prompt || "No description."}</pre>
                <div className="field-row">
                  <label className="field"><span>Repo</span><select value={values.repo_path} onChange={(e) => update({ repo_path: e.target.value })}>
                    <option value="">No repository</option>
                    {values.repo_path && !repos.some((repo) => repo.path === values.repo_path) ? <option value={values.repo_path}>{values.repo_path}</option> : null}
                    {repos.map((repo) => <option key={repo.id} value={repo.path}>{repo.name} — {repo.path}</option>)}
                  </select></label>
                  <label className="field"><span>Base branch (optional)</span><input value={values.base_branch} onChange={(e) => update({ base_branch: e.target.value })} placeholder="main" /></label>
                </div>
                {favorites.length > 0 ? <div className="field"><span>Favorites</span><div className="chip-row">{favorites.map((f, i) => <button type="button" className="chip" key={i} disabled={!targets.includes(f.harness)} onClick={() => update({ target: f.harness, agent: f.agent, model: f.model, reasoning: f.reasoning })}>{f.name}</button>)}</div></div> : null}
                <div className="field-row">
                  <label className="field"><span>Harness</span><select value={values.target} onChange={(e) => update({ target: e.target.value, agent: "", model: "", reasoning: "" })}><option value="">Choose at dispatch</option>{targets.map((t) => <option key={t} value={t}>{harnessLabel(t, quotas)}</option>)}</select></label>
                  <label className="field"><span>Agent</span><select value={values.agent} onChange={(e) => update({ agent: e.target.value })} disabled={!values.target}><option value="">— none (bare harness) —</option>{values.agent && !(agentOptions[values.target] ?? []).some((a) => a.id === values.agent) ? <option value={values.agent}>{values.agent} (unavailable)</option> : null}{(agentOptions[values.target] ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                </div>
                {values.target ? <div className="field-row"><ModelSettings models={catalog[values.target] ?? []} model={values.model} reasoning={values.reasoning} setModel={(model) => update({ model })} setReasoning={(reasoning) => update({ reasoning })} fieldClass="field" /></div> : null}
              </div>
            ); })}
          </div>
          <div className="form-foot">
            <button className="btn btn-primary" onClick={() => void importSelected()} disabled={busy !== null}>
              {busy === "import" ? <Spinner /> : null}
              Confirm import ({selected.length})
            </button>
            <button className="btn" onClick={() => setReviewing(false)} disabled={busy !== null}>
              Back
            </button>
          </div>
        </>
      ) : results.length === 0 ? (
        <div className="pane-note">No issues found.</div>
      ) : (
        <>
          <div className="import-list">
            {results.map((r) => {
              const imported = r.existing_task_id !== null;
              const open = expandedKeys.has(r.jira_key);
              return (
                <div className={`import-item ${imported ? "import-item-done" : ""}`} key={r.jira_key}>
                  <div className="import-row">
                    <button
                      type="button"
                      className="import-toggle"
                      onClick={() => toggle(setExpandedKeys, r.jira_key)}
                      aria-label={open ? "Hide description" : "Show description"}
                      aria-expanded={open}
                    >
                      <Chevron open={open} />
                    </button>
                    <label className="import-row-head">
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(r.jira_key)}
                        disabled={imported}
                        onChange={() => toggle(setSelectedKeys, r.jira_key)}
                      />
                      <span className="import-title">{r.title}</span>
                    </label>
                    {r.jira_status ? <span className="badge">{r.jira_status}</span> : null}
                    {imported ? <span className="badge badge-mute">already imported</span> : repoBadge(r)}
                    {r.jira_parent_key ? <span className="badge">{r.jira_parent_key}</span> : null}
                    <a href={r.jira_url} target="_blank" rel="noreferrer" className="meta-link">
                      {r.jira_key}
                      <ExternalLinkIcon />
                    </a>
                  </div>
                  {open ? <pre className="import-prompt">{r.prompt || "No description."}</pre> : null}
                </div>
              );
            })}
          </div>
          <div className="form-foot">
            <button
              className="btn btn-primary"
              onClick={() => setReviewing(true)}
              disabled={busy !== null || selected.length === 0}
            >
              Review import ({selected.length})
            </button>
            <button className="btn" onClick={onClose} disabled={busy !== null}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ModelSettings({ models, model, reasoning, setModel, setReasoning, fieldClass }: { models: ModelOption[]; model: string; reasoning: string; setModel: (value: string) => void; setReasoning: (value: string) => void; fieldClass: string }) {
  const levels = reasoningChoices(models, model, reasoning);
  const hasLevels = model ? (models.find((m) => m.id === model)?.reasoning.length ?? 0) > 0 : models.some((m) => m.reasoning.length > 0);
  return <>
    <label className={fieldClass}><span>Model</span>{models.length ? <select value={model} onChange={(e) => setModel(e.target.value)}><option value="">Harness default</option>{modelChoices(models, model).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select> : <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Harness default" />}</label>
    <label className={fieldClass}><span>Reasoning level</span>{hasLevels ? <select value={reasoning} onChange={(e) => setReasoning(e.target.value)}><option value="">Harness default</option>{levels.map((level) => <option key={level} value={level}>{level}</option>)}</select> : <input value={reasoning} onChange={(e) => setReasoning(e.target.value)} placeholder="Harness default" />}</label>
  </>;
}
