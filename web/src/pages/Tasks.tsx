// Tasks — dispatch queue grouped by repository.

import { useEffect, useMemo, useRef, useState } from "react";
import { filterTasks, groupTasks, harnessLabel, sortRepos, lastHarnessSettings, lastSpecFolder, modelChoices, reasoningChoices } from "../task-page";
import type { ModelOption } from "../task-page";
import { api } from "../api";
import { TaskHistoryButton } from "../TaskHistory";
import { toAttachmentInputs } from "../attachment-input";
import { PromptAttachments } from "../PromptAttachments";
import type { DispatchResult, NewTaskInput } from "../api";
import type { AgentQuota, Context, Favorite, JiraSearchResult, ModelAvailability, ModelCatalog, Repo, Reviewer, Task } from "../types";
import { modelFactsReport, retentionLabel } from "../model-indicators";
import { usePeakNow } from "../use-peak-now";
import type { HarnessModels, ModelFactsReport, ModelSelection } from "../model-indicators";
import { favoritesFor, repoContext } from "../favorite-context";
import { errText, formatTs, isPrUrl, prLabel, REVIEW_HARNESS, timeAgo } from "../util";
import { Chevron, ExternalLinkIcon, Spinner } from "../ui";
import { batchImportItems } from "../jira-import";
import type { ImportSettings } from "../jira-import";
import { taskFocusFromHash, taskPrefillFromHash } from "../selection-task";
import type { TaskPrefill } from "../selection-task";

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
  const [modelFacts, setModelFacts] = useState<ModelCatalog>({});
  const [providerModels, setProviderModels] = useState<Record<string, ModelAvailability>>({});
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  /** Something picked elsewhere (an inbox selection, a PR from the Pulls page). */
  const [prefill, setPrefill] = useState<TaskPrefill | null>(() => taskPrefillFromHash(window.location.hash));
  const clearPrefill = useMemo(() => () => setPrefill(null), []);
  /** A daily activity item links here with `#/tasks?task=<id>`. */
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(() => taskFocusFromHash(window.location.hash));

  // A deep link (#/tasks?prompt=… or #/tasks?review=…) becomes form state, then
  // leaves the URL so a reload or a shared link does not resurrect a stale one.
  useEffect(() => {
    const read = () => {
      const next = taskPrefillFromHash(window.location.hash);
      const focus = taskFocusFromHash(window.location.hash);
      if (next) {
        setPrefill(next);
        history.replaceState(null, "", "#/tasks");
      }
      setFocusedTaskId(focus);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

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

  // Model facts and local-server availability: a page that cannot read them
  // still renders, the choices just say "no data" / "unknown".
  useEffect(() => {
    api.getModels().then((res) => setModelFacts(res.models)).catch(() => undefined);
    api.getModelAvailability().then((res) => setProviderModels(res.providers)).catch(() => undefined);
    api.getConfig().then((cfg) => setReviewers(cfg.reviewers ?? [])).catch(() => undefined);
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

  // Reveal a task linked from another page: done tasks are hidden by default,
  // and its repo group may be collapsed.
  useEffect(() => {
    if (!focusedTaskId || loading) return;
    const target = tasks.find((task) => task.id === focusedTaskId);
    if (!target) return;
    if ((target.status === "done" || target.status === "archived") && !showDoneArchived) {
      setShowDoneArchived(true);
      return;
    }
    const key = target.repo_path || "";
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [focusedTaskId, tasks, loading, showDoneArchived]);

  useEffect(() => {
    if (!focusedTaskId || loading) return;
    const rows = document.querySelectorAll<HTMLElement>(".task-row[data-task-id]");
    for (const row of rows) {
      if (row.dataset.taskId === focusedTaskId) {
        row.scrollIntoView({ block: "center" });
        break;
      }
    }
  }, [focusedTaskId, tasks, loading, showDoneArchived, collapsed]);

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
              <TaskRow key={task.id} task={task} focused={task.id === focusedTaskId} repos={sortedRepos} targets={targets} quotas={quotas} agentOptions={agentOptions} catalog={catalog} modelFacts={modelFacts} providerModels={providerModels} reviewers={reviewers} version={eventVersion} refresh={refresh} parentTitle={task.parent_task_id ? parentLabel(tasks, task.parent_task_id) : null} />
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

        {showImport ? <JiraImport repos={sortedRepos} targets={targets} quotas={quotas} agentOptions={agentOptions} catalog={catalog} modelFacts={modelFacts} providerModels={providerModels} onImported={refresh} onClose={() => setShowImport(false)} /> : null}
        <NewTaskForm tasks={tasks} repos={sortedRepos} targets={targets} quotas={quotas} agentOptions={agentOptions} catalog={catalog} modelFacts={modelFacts} providerModels={providerModels} reviewers={reviewers} prefill={prefill} onPrefillHandled={clearPrefill} onDone={refresh} />

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
  focused,
  repos,
  targets,
  quotas,
  agentOptions,
  catalog,
  modelFacts,
  providerModels,
  reviewers,
  version,
  refresh,
  parentTitle,
}: {
  task: Task;
  /** Linked from the daily page: highlight this row. */
  focused: boolean;
  /** Title of the spec task this one was created from (multi-repo), or null. */
  parentTitle: string | null;
  repos: Repo[];
  targets: string[];
  quotas: AgentQuota[];
  agentOptions: Record<string, { id: string; name: string }[]>;
  catalog: Record<string, ModelOption[]>;
  modelFacts: ModelCatalog;
  providerModels: Record<string, ModelAvailability>;
  reviewers: Reviewer[];
  /** SSE-driven counter: an open history refetches when the task moves. */
  version: number;
  refresh: () => void;
}) {
  const now = usePeakNow();
  const [showDispatch, setShowDispatch] = useState(task.status === "open" || (task.status === "dispatched" && !task.terminal_address));
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [prompt, setPrompt] = useState(task.prompt);
  const [baseBranch, setBaseBranch] = useState(task.base_branch ?? "");
  const [target, setTarget] = useState(task.target || "claude");
  const [model, setModel] = useState(task.model ?? "");
  const [reasoning, setReasoning] = useState(task.reasoning ?? "");
  const [agent, setAgent] = useState(task.agent ?? "");
  const [reviewName, setReviewName] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const [dispatchResult, setDispatchResult] = useState<DispatchResult | null>(null);
  const [showComment, setShowComment] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  const review = task.kind === "review";
  const spec = task.kind === "spec";
  // A review or a spec runs in place: no worktree, no branch, no base branch.
  const inPlace = review || spec;
  const rowTargets = review ? targets.filter((t) => t === REVIEW_HARNESS) : targets;
  const selectedTarget = rowTargets.includes(target) ? target : rowTargets[0] ?? "";

  const dispatch = async () => {
    if (busy) return;
    setBusy("dispatch");
    setError(null);
    setMsg(null);
    try {
      const base = baseBranch.trim() || null;
      if (!inPlace && base !== task.base_branch) await api.patchTask(task.id, { base_branch: base });
      const result = await api.dispatchTask(task.id, {
        target: selectedTarget,
        use_worktree: inPlace ? false : useWorktree,
        agent: agent || null,
        model: model.trim() || null,
        reasoning: reasoning.trim() || null,
        review: inPlace ? null : reviewName || null,
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

  const copyDescription = async () => {
    const text = task.prompt;
    if (!text.trim()) return;
    let ok = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (!ok) ok = copyWithExecCommand(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      setError("Copy failed");
    }
  };

  return (
    <div className={`task-row${focused ? " task-row-focused" : ""}`} data-task-id={task.id}>
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
          {review ? <span className="badge badge-review" title="Reviews the linked PR/MR; comments are published after your approval">review</span> : null}
          {spec ? <span className="badge badge-review" title="Writes the contract between the sub-projects in repo_path; approving its plan in the inbox creates one task per sub-project">multi-repo spec</span> : null}
          {parentTitle ? <span className="badge badge-review" title="Created from a multi-repo plan; the contract is appended to this task's prompt">from {parentTitle}</span> : null}
          {task.target ? <span className="badge badge-target">{task.target}</span> : null}
          {task.attachment_count ? <span className="badge badge-target" title="Files sent to the agent with the prompt">{task.attachment_count} {task.attachment_count === 1 ? "attachment" : "attachments"}</span> : null}
          {task.terminal_address ? <>
            <span className="muted">Model: {task.session_model || "Unknown"}</span>
            <span className="muted">Reasoning: {task.session_reasoning || "Unknown"}</span>
          </> : null}
          {task.branch ? <span className="mono">{task.branch}</span> : null}
          {task.review ? <span className="mono muted" title="Review command (frozen at dispatch)">review: {task.review}</span> : null}
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
          <TaskHistoryButton taskId={task.id} title={task.title || firstLine(task.prompt) || "Untitled task"} version={version} />
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
            {dispatchResult.branch ? <span className="mono">branch: {dispatchResult.branch}</span> : null}
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
                {rowTargets.length === 0 ? <option value="">{review ? "Claude harness unavailable" : "No configured harnesses"}</option> : null}
                {rowTargets.map((t) => (
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
            {inPlace ? null : <label className="field-inline">
              <span>Reviewer</span>
              <select value={reviewName} onChange={(e) => setReviewName(e.target.value)}>
                <option value="">— none —</option>
                {reviewName && !reviewers.some((r) => r.name === reviewName) ? <option value={reviewName}>{reviewName} (unavailable)</option> : null}
                {reviewers.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
            </label>}
            <ModelSettings models={catalog[selectedTarget] ?? []} model={model} reasoning={reasoning} setModel={setModel} setReasoning={setReasoning} fieldClass="field-inline" />
            <ModelFactsLine report={modelFactsReport({
              selection: { harness: selectedTarget, model, reasoning },
              catalog: modelFacts,
              quota: quotas,
              harnesses: harnessModels(catalog),
              context: repoContext(repos, task.repo_path),
              providers: providerModels,
              now,
            })} />
            {inPlace ? null : <>
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
            </>}
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
        <span className="visually-hidden" aria-live="polite">
          {copied ? "Description copied" : ""}
        </span>
        <button className="btn" onClick={() => void copyDescription()} disabled={busy !== null || !task.prompt.trim()} title="Copy the task description as markdown">
          {copied ? "Copied" : "Copy description"}
        </button>
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

function FavoritesTitle({ context }: { context: Context | null }) {
  return <span>Favorites{context ? <> <span className="badge badge-mute">{context}</span></> : null}</span>;
}

/** Harness catalogs as the indicators expect them (empty models = not reported). */
function harnessModels(catalog: Record<string, ModelOption[]>): HarnessModels[] {
  return Object.entries(catalog).map(([harness, models]) => ({ harness, models }));
}

/** Every fact and warning for a choice, one line, full detail in the tooltip. */
export function ModelFactsLine({ report }: { report: ModelFactsReport }) {
  const asOf = report.indicators.find((row) => row.key === "asOf")?.value;
  return (
    <div className="model-facts" title={report.title}>
      <span className="model-facts-label">Model facts</span>
      <span className={`model-facts-values${report.hasFacts ? "" : " muted"}`}>{report.summary}</span>
      {report.peak ? <span className="badge badge-peak" title={`Peak hours: the rate is doubled until ${report.peak.until}`}>2× peak until {report.peak.until}</span> : null}
      {report.retention ?
        <span className={`badge retention-${report.retention}`} title={`Data retention: ${retentionLabel(report.retention)}`}>retention {retentionLabel(report.retention)}</span> : null}
      {report.warnings.map((warning) => (
        <span key={warning.key} className="badge badge-warn" title={warning.message}>⚠ {warning.label}</span>
      ))}
      {asOf ? <span className="model-facts-asof">as of {asOf}</span> : null}
    </div>
  );
}

/** A saved combination with its facts: one click still picks exactly it. */
function FavoriteChip({ favorite, disabled, report, onPick }: { favorite: Favorite; disabled: boolean; report: ModelFactsReport; onPick: () => void }) {
  return (
    <button
      type="button"
      className="chip chip-favorite"
      disabled={disabled}
      title={disabled ? `Harness unavailable\n${report.title}` : report.title}
      onClick={onPick}
    >
      <span className="chip-name">{favorite.name}</span>
      <span className="chip-facts">{report.summary}</span>
      {report.peak ? <span className="badge badge-peak" title={`Peak hours: the rate is doubled until ${report.peak.until}`}>2× peak</span> : null}
      {report.retention ? <span className={`badge retention-${report.retention}`} title={`Data retention: ${retentionLabel(report.retention)}`}>{retentionLabel(report.retention)}</span> : null}
      {report.warnings.map((warning) => (
        <span key={warning.key} className="badge badge-warn" title={warning.message}>⚠ {warning.label}</span>
      ))}
    </button>
  );
}

// ---- new task form ----

function parentLabel(tasks: Task[], id: string): string {
  const parent = tasks.find((t) => t.id === id);
  return parent ? (parent.title.trim() || firstLine(parent.prompt) || "spec") : "plan";
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0].slice(0, 120);
}

/** Legacy clipboard fallback for contexts without the async Clipboard API. */
function copyWithExecCommand(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

// No title (omnigent names the session) and no target (picked at dispatch).
function NewTaskForm({ tasks, repos, targets, quotas, agentOptions, catalog, modelFacts, providerModels, reviewers, prefill, onPrefillHandled, onDone }: { tasks: Task[]; repos: Repo[]; targets: string[]; quotas: AgentQuota[]; agentOptions: Record<string, { id: string; name: string }[]>; catalog: Record<string, ModelOption[]>; modelFacts: ModelCatalog; providerModels: Record<string, ModelAvailability>; reviewers: Reviewer[]; prefill: TaskPrefill | null; onPrefillHandled: () => void; onDone: () => void }) {
  const now = usePeakNow();
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  useEffect(() => { api.getConfig().then((cfg) => setFavorites(cfg.favorites ?? [])).catch(() => undefined); }, []);
  const [kind, setKind] = useState<"code" | "review" | "spec">("code");
  const [prUrl, setPrUrl] = useState("");
  const [prompt, setPrompt] = useState(prefill?.text ?? "");
  /** Files dropped, pasted or picked for the prompt; sent with the task. */
  const [files, setFiles] = useState<File[]>([]);
  const [repoChoice, setRepoChoice] = useState("");
  const [target, setTarget] = useState("");
  const [agent, setAgent] = useState("");
  const [settings, setSettings] = useState<Record<string, { model: string; reasoning: string }>>({});
  const [repoTouched, setRepoTouched] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  /** null reads as "use the newest spec task's folder"; an empty string is a deliberate clear. */
  const [specFolder, setSpecFolder] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [reviewName, setReviewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the deep link that filled the form was: a selection or a PR to review. */
  const [prefilled, setPrefilled] = useState<"selection" | "review" | null>(() => (prefill ? (prefill.prUrl ? "review" : "selection") : null));
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const prUrlRef = useRef<HTMLInputElement | null>(null);

  // Picked elsewhere: a passage becomes the prompt, a PR/MR becomes a review.
  useEffect(() => {
    if (!prefill) return;
    onPrefillHandled();
    if (prefill.prUrl) {
      setKind("review");
      setPrUrl(prefill.prUrl);
      setPrefilled("review");
      const frame = requestAnimationFrame(() => {
        prUrlRef.current?.scrollIntoView({ block: "center" });
        prUrlRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    setKind("code");
    setPrompt(prefill.text ?? "");
    setPrefilled("selection");
    const frame = requestAnimationFrame(() => {
      promptRef.current?.scrollIntoView({ block: "center" });
      promptRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [prefill, onPrefillHandled]);

  const clear = () => {
    setPrompt("");
    setFiles([]);
    setPrUrl("");
    setRepoPath("");
    setBaseBranch("");
    setError(null);
    setPrefilled(null);
  };

  const selectedRepo = repoTouched ? repoChoice : (repos[0]?.path ?? "");
  const formContext = repoContext(repos, selectedRepo);
  const shownFavorites = favoritesFor(favorites, formContext);
  const review = kind === "review";
  const spec = kind === "spec";
  const folderPath = specFolder ?? lastSpecFolder(tasks);
  const formTargets = review ? targets.filter((t) => t === REVIEW_HARNESS) : targets;
  const selectedTarget = formTargets.includes(target) ? target : formTargets[0] ?? "";
  const prUrlValid = isPrUrl(prUrl);
  const hasContent = review ? prUrlValid : !!prompt.trim();

  const selectedSettings = settings[selectedTarget] ?? lastHarnessSettings(tasks, selectedTarget);
  const setSetting = (key: "model" | "reasoning", value: string) => setSettings((prev) => ({ ...prev, [selectedTarget]: { ...selectedSettings, [key]: value } }));

  const submit = async (dispatch: boolean) => {
    if (!hasContent || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input: NewTaskInput = {
        ...(review ? { kind, pr_url: prUrl.trim(), title: `Review ${prLabel(prUrl.trim())}` } : spec ? { kind } : {}),
        prompt,
        ...(files.length ? { attachments: await toAttachmentInputs(files) } : {}),
        target: selectedTarget,
        model: selectedSettings.model.trim() || null,
        reasoning: selectedSettings.reasoning.trim() || null,
        repo_path: spec ? folderPath.trim() : selectedRepo === "__custom__" ? repoPath.trim() : selectedRepo,
        base_branch: review || spec ? null : baseBranch.trim() || null,
      };
      const task = await api.createTask(input);
      clear();
      onDone();
      if (dispatch) {
        try {
          await api.dispatchTask(task.id, { target: selectedTarget, use_worktree: !review && !spec, agent: agent || null, review: review || spec ? null : reviewName || null });
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
      {prefilled ? (
        <p className="inline-ok" role="status">
          {prefilled === "review"
            ? "PR/MR prefilled from the Pull Requests page — check the harness, then create or dispatch."
            : "Prompt prefilled from your selection — edit it, then create or dispatch."}
        </p>
      ) : null}
      <div className="seg" role="radiogroup" aria-label="Task type">
        <button type="button" role="radio" aria-checked={!review && !spec} className={`seg-btn${review || spec ? "" : " active"}`} onClick={() => setKind("code")}>Code change</button>
        <button type="button" role="radio" aria-checked={review} className={`seg-btn${review ? " active" : ""}`} onClick={() => setKind("review")}>Review a PR/MR</button>
        <button type="button" role="radio" aria-checked={spec} className={`seg-btn${spec ? " active" : ""}`} onClick={() => setKind("spec")}>Multi-repo</button>
      </div>
      {review ? (
        <>
          <label className="field">
            <span>PR/MR URL</span>
            <input ref={prUrlRef} value={prUrl} onChange={(e) => setPrUrl(e.target.value)} placeholder="https://gitlab.com/group/project/-/merge_requests/123" />
          </label>
          {prUrl.trim() && !prUrlValid ? <div className="inline-error">Paste a GitHub pull request or GitLab merge request URL.</div> : null}
          <p className="muted form-hint">The agent reviews with the fabien-reviewer skill and posts comments as drafts. Nothing is published until you approve the list in the inbox. No branch, no code changes.</p>
        </>
      ) : null}
      {spec ? (
        <>
          <label className="field">
            <span>Folder of sub-projects</span>
            <input value={folderPath} onChange={(e) => setSpecFolder(e.target.value)} placeholder="/path/to/folder (one git repo per directory)" />
          </label>
          <p className="muted form-hint">Step one: the agent reads the sub-projects and writes the contract between them, then proposes one task per sub-project. Nothing is created until you approve the plan in the inbox. No branch, no code changes. Name any system map or architecture doc in the prompt.</p>
        </>
      ) : null}
      <PromptAttachments files={files} onChange={setFiles} disabled={busy}>
        <label className="field">
          <span>{review ? "Focus (optional)" : "Prompt"}</span>
          <textarea
            ref={promptRef}
            rows={review ? 3 : 6}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={review ? "Anything to look at in particular?" : "What should the agent do?"}
          />
        </label>
      </PromptAttachments>
      {spec ? null : <div className="field-row">
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
        {review ? null : (
          <label className="field">
            <span>Base branch (optional)</span>
            <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
          </label>
        )}
      </div>}
      {favorites.length > 0 ? <div className="field"><FavoritesTitle context={formContext} /><div className="chip-row">{shownFavorites.length === 0 ? <span className="muted">No {formContext} favorites</span> : null}{shownFavorites.map((f, i) => (
        <FavoriteChip
          key={i}
          favorite={f}
          disabled={!formTargets.includes(f.harness)}
          report={modelFactsReport({ selection: { harness: f.harness, model: f.model, reasoning: f.reasoning }, catalog: modelFacts, quota: quotas, harnesses: harnessModels(catalog), context: formContext, providers: providerModels, now })}
          onPick={() => { setTarget(f.harness); setAgent(f.agent); setReviewName(f.review ?? ""); setSettings((prev) => ({ ...prev, [f.harness]: { model: f.model, reasoning: f.reasoning } })); }}
        />
      ))}</div></div> : null}
      <div className="field-row">
        <label className="field"><span>Harness</span><select value={selectedTarget} onChange={(e) => { setTarget(e.target.value); setAgent(""); }}>
          {formTargets.length === 0 ? <option value="">{review ? "Claude harness unavailable" : "No configured harnesses"}</option> : null}
          {formTargets.map((t) => <option key={t} value={t}>{harnessLabel(t, quotas)}</option>)}
        </select></label>
        <label className="field"><span>Agent</span><select value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">— none (bare harness) —</option>
          {agent && !(agentOptions[selectedTarget] ?? []).some((a) => a.id === agent) ? <option value={agent}>{agent} (unavailable)</option> : null}
          {(agentOptions[selectedTarget] ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select></label>
      </div>
      {review || spec ? null : <div className="field-row">
        <label className="field"><span>Reviewer</span><select value={reviewName} onChange={(e) => setReviewName(e.target.value)}>
          <option value="">— none —</option>
          {reviewName && !reviewers.some((r) => r.name === reviewName) ? <option value={reviewName}>{reviewName} (unavailable)</option> : null}
          {reviewers.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
        </select></label>
      </div>}
      <div className="field-row">
        <ModelSettings models={catalog[selectedTarget] ?? []} model={selectedSettings.model} reasoning={selectedSettings.reasoning} setModel={(value) => setSetting("model", value)} setReasoning={(value) => setSetting("reasoning", value)} fieldClass="field" />
      </div>
      <ModelFactsLine report={modelFactsReport({
        selection: { harness: selectedTarget, model: selectedSettings.model, reasoning: selectedSettings.reasoning },
        catalog: modelFacts,
        quota: quotas,
        harnesses: harnessModels(catalog),
        context: formContext,
        providers: providerModels,
        now,
      })} />
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="form-foot">
        <button className="btn btn-primary" onClick={() => void submit(true)} disabled={busy || !hasContent || !selectedTarget || (!!agent && !(agentOptions[selectedTarget] ?? []).some((a) => a.id === agent)) || !(spec ? folderPath.trim() : selectedRepo === "__custom__" ? repoPath.trim() : selectedRepo)}>
          Create and dispatch
        </button>
        <button className="btn" onClick={() => void submit(false)} disabled={busy || !hasContent || (spec && !folderPath.trim())}>
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

function JiraImport({ repos, targets, quotas, agentOptions, catalog, modelFacts, providerModels, onImported, onClose }: { repos: Repo[]; targets: string[]; quotas: AgentQuota[]; agentOptions: Record<string, { id: string; name: string }[]>; catalog: Record<string, ModelOption[]>; modelFacts: ModelCatalog; providerModels: Record<string, ModelAvailability>; onImported: () => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<JiraSearchResult[] | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState<"search" | "import" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = usePeakNow();
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [values, setSettings] = useState<ImportSettings>({ repo_path: "", base_branch: "", target: "", agent: "", model: "", reasoning: "" });
  const update = (patch: Partial<ImportSettings>) => setSettings((prev) => ({ ...prev, ...patch }));
  const importContext = repoContext(repos, values.repo_path);
  const shownFavorites = favoritesFor(favorites, importContext);

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
      const res = await api.jiraImport(batchImportItems(selected, values));
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
          <div className="import-review">
                <div className="muted">Settings apply to all selected tasks.</div>
                <div className="field-row">
                  <label className="field"><span>Repo</span><select value={values.repo_path} onChange={(e) => update({ repo_path: e.target.value })}>
                    <option value="">Use Jira prefix mappings</option>
                    {repos.map((repo) => <option key={repo.id} value={repo.path}>{repo.name} — {repo.path}</option>)}
                  </select></label>
                  <label className="field"><span>Base branch (optional)</span><input value={values.base_branch} onChange={(e) => update({ base_branch: e.target.value })} placeholder="main" /></label>
                </div>
                {favorites.length > 0 ? <div className="field"><FavoritesTitle context={importContext} /><div className="chip-row">{shownFavorites.length === 0 ? <span className="muted">No {importContext} favorites</span> : null}{shownFavorites.map((f, i) => (
                  <FavoriteChip
                    key={i}
                    favorite={f}
                    disabled={!targets.includes(f.harness)}
                    report={modelFactsReport({ selection: { harness: f.harness, model: f.model, reasoning: f.reasoning }, catalog: modelFacts, quota: quotas, harnesses: harnessModels(catalog), context: importContext, providers: providerModels, now })}
                    onPick={() => update({ target: f.harness, agent: f.agent, model: f.model, reasoning: f.reasoning })}
                  />
                ))}</div></div> : null}
                <div className="field-row">
                  <label className="field"><span>Harness</span><select value={values.target} onChange={(e) => update({ target: e.target.value, agent: "", model: "", reasoning: "" })}><option value="">Choose at dispatch</option>{targets.map((t) => <option key={t} value={t}>{harnessLabel(t, quotas)}</option>)}</select></label>
                  <label className="field"><span>Agent</span><select value={values.agent} onChange={(e) => update({ agent: e.target.value })} disabled={!values.target}><option value="">— none (bare harness) —</option>{values.agent && !(agentOptions[values.target] ?? []).some((a) => a.id === values.agent) ? <option value={values.agent}>{values.agent} (unavailable)</option> : null}{(agentOptions[values.target] ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
                </div>
                {values.target ? <div className="field-row"><ModelSettings models={catalog[values.target] ?? []} model={values.model} reasoning={values.reasoning} setModel={(model) => update({ model })} setReasoning={(reasoning) => update({ reasoning })} fieldClass="field" /></div> : null}
                {values.target ? <ModelFactsLine report={modelFactsReport({ selection: { harness: values.target, model: values.model, reasoning: values.reasoning }, catalog: modelFacts, quota: quotas, harnesses: harnessModels(catalog), context: importContext, providers: providerModels, now })} /> : null}
          </div>
          <div className="import-list">
            {selected.map((r) => (
              <div className="import-review" key={r.jira_key}>
                <div className="import-row-head">
                  <span className="import-title">{r.title}</span>
                  {r.jira_status ? <span className="badge">{r.jira_status}</span> : null}
                  {!values.repo_path ? repoBadge(r) : null}
                </div>
                <pre className="import-prompt">{r.prompt || "No description."}</pre>
              </div>
            ))}
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
