// Inbox — mail-style two-pane dispatch-and-review view.

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { api } from "../api";
import type { Item, SessionInfo, Task, TrackedTerminal } from "../types";
import { errText, formatTs, itemPrUrl, prLabel, snoozeUntil, timeAgo } from "../util";
import { ExternalLinkIcon, JiraPill, KindIcon, Spinner } from "../ui";
import { Markdown } from "../markdown";
import { ItemBody } from "../item-body";
import { agentRunStatus, inProgressInboxItems, inProgressInboxTasks, isHandlingItem, openInboxItems, selectedInboxItem, type AgentRunStatus } from "../inbox-selection";
import { INBOX_ACTION_COOLDOWN_MS, inboxActionsLocked } from "../inbox-action-lock";
import { useVisibleInboxItems } from "../use-visible-inbox-items";
import { inboxTitle, itemDisplayTitle } from "../inbox-title";
import { replyQuestions } from "../question-reply";
import { parseGrillRound, formatGrillAnswers } from "../grill-format";
import { QuestionReply } from "../QuestionReply";
import { GrillRoundDialog } from "../GrillRoundDialog";
import { TaskHistoryButton } from "../TaskHistory";
import { ResizeHandle } from "../ResizeHandle";
import { usePaneWidth } from "../use-pane-size";
import type { PaneLimits } from "../pane-size";

type StatusFilter = "open" | "snoozed" | "in-progress";

const LIST_LIMITS: PaneLimits = { min: 260, max: 640 };
const LIST_DEFAULT_WIDTH = 380;
/** The detail pane never gets squeezed below this. */
const DETAIL_MIN_WIDTH = 320;

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "snoozed", label: "Snoozed" },
  { key: "in-progress", label: "In progress" },
];

function AgentRunBadge({ status }: { status: AgentRunStatus }) {
  const label = status === "running" ? "agent running" : status === "stopped" ? "agent stopped" : "agent status unknown";
  const title = status === "running"
    ? "Omnigent session is working or waiting on you."
    : status === "stopped"
      ? "Omnigent session stopped while this task is still dispatched."
      : "No Omnigent session status is available for this task.";
  return <span className={`badge badge-agent-${status}`} title={title}>{label}</span>;
}

/** Force refresh: re-check the task's PR/MR now and hand any unaddressed
 *  review comments or merge conflicts to the agent — the manual escape hatch
 *  of the PR loop when an automatic hand-off did not land. */
function ForcePrRefresh({ task, onChecked }: { task: Task; onChecked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const res = await api.checkPr(task.id, { force: true });
      const delivered = res.delivered;
      if (!delivered) {
        setNote(res.pr ? "Checked — nothing new to hand to the agent." : "No PR/MR found for this branch yet.");
      } else if (!delivered.address) {
        // The PR loop could not reach an agent: retryable, so say what failed.
        setError("Could not hand the work to an agent. Check the session, then retry.");
      } else {
        const what = [delivered.comments ? "review comments" : "", delivered.conflict ? "merge conflicts" : ""]
          .filter(Boolean)
          .join(" and ");
        setNote(`Sent ${what} to the agent.`);
      }
      onChecked();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="btn"
        onClick={() => void run()}
        disabled={busy}
        title="Check this PR/MR now and hand unaddressed review comments or merge conflicts to the agent"
      >
        {busy ? <Spinner /> : null}
        {busy ? "Refreshing…" : "Force refresh"}
      </button>
      {note ? <span className="inline-ok">{note}</span> : null}
      {error ? <span className="inline-error">{error}</span> : null}
    </>
  );
}

function RequestArtifact({ task }: { task: Task }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (task.target !== "claude" || task.status !== "dispatched" || !task.terminal_address) return null;
  const run = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      await api.requestArtifact(task.id);
      setNote("Request sent. Claude will report the artifact link in the inbox.");
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  };
  return <>
    <button className="btn" disabled={busy} onClick={() => void run()}>{busy ? "Requesting…" : "Ask Claude for an artifact"}</button>
    {note ? <span className="inline-ok" role="status">{note}</span> : null}
    {error ? <span className="inline-error" role="alert">{error}</span> : null}
  </>;
}

export function InboxPage({ active, eventVersion, refresh, onSeen }: { active: boolean; eventVersion: number; refresh: () => void; onSeen: (items: Item[]) => void }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [terminals, setTerminals] = useState<TrackedTerminal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncRequest, setSyncRequest] = useState<"idle" | "requesting" | "requested" | "error">("idle");
  const [selected, setSelected] = useState<Item | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const listSize = usePaneWidth("corral.inboxListWidth", LIST_DEFAULT_WIDTH, LIST_LIMITS);

  const [replyText, setReplyText] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyOk, setReplyOk] = useState<string | null>(null);
  const [summarizeBusy, setSummarizeBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionUnlockAt, setActionUnlockAt] = useState(0);
  const [actionClock, setActionClock] = useState(0);
  const actionsLocked = inboxActionsLocked(actionBusy, actionUnlockAt, actionClock);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  const [attachCmd, setAttachCmd] = useState<string | null>(null);
  const [grillOpen, setGrillOpen] = useState(false);

  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  // A different item must not inherit an open interview round.
  useEffect(() => { setGrillOpen(false); }, [selected?.id]);

  // The cooldown outlives the selected item: the next one moves under the
  // same buttons as soon as the current item leaves the list.
  useEffect(() => {
    if (actionUnlockAt <= actionClock) return;
    const timer = setTimeout(() => setActionClock(Date.now()), actionUnlockAt - actionClock);
    return () => clearTimeout(timer);
  }, [actionUnlockAt, actionClock]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.listItems(),
      api.listTasks(),
      api.listSessions().catch(() => [] as SessionInfo[]),
      api.listTerminals().catch(() => [] as TrackedTerminal[]),
    ])
      .then(([itemList, taskList, sessionList, terminalList]) => {
        if (cancelled) return;
        setAllItems(itemList);
        setTasks(taskList);
        setSessions(sessionList);
        setTerminals(terminalList);
        setError(null);
        setSelected((prev) => selectedInboxItem(prev, itemList, statusFilter));
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
  }, [active, eventVersion, statusFilter]);

  // Opening the inbox re-checks PRs: merged ones get resolved (server
  // broadcasts the changes, which bumps eventVersion and reloads the list).
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const sync = () => {
      if (document.visibilityState !== "visible") return;
      setSyncRequest("requesting");
      void api.syncPrs().then(() => { if (!cancelled) setSyncRequest("requested"); })
        .catch(() => { if (!cancelled) setSyncRequest("error"); });
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", sync); };
  }, [active]);

  const visibleItems = useVisibleInboxItems(allItems);
  const snoozedItems = useVisibleInboxItems(allItems, "snoozed");
  const inProgressItems = useMemo(() => inProgressInboxItems(allItems, tasks), [allItems, tasks]);
  const inProgressTasks = useMemo(() => inProgressInboxTasks(tasks, allItems), [tasks, allItems]);
  const openItems = useMemo(() => openInboxItems(visibleItems), [visibleItems]);
  const items = statusFilter === "snoozed" ? snoozedItems : statusFilter === "in-progress" ? inProgressItems : openItems;
  useEffect(() => {
    const acknowledge = () => {
      if (active && !loading && !error && statusFilter === "open" && document.visibilityState === "visible") onSeen(items);
    };
    acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    return () => document.removeEventListener("visibilitychange", acknowledge);
  }, [active, items, loading, error, statusFilter, onSeen]);

  const counts: Record<StatusFilter, number> = { open: openItems.length, snoozed: snoozedItems.length, "in-progress": inProgressItems.length + inProgressTasks.length };

  // Auto-select the first row when nothing is selected.
  useEffect(() => {
    if (selectedTaskId && statusFilter === "in-progress" && inProgressTasks.some((task) => task.id === selectedTaskId)) return;
    if (selectedTaskId) setSelectedTaskId(null);
    const current = selectedInboxItem(selected, items, statusFilter);
    if (current !== selected) setSelected(current ?? items[0] ?? null);
    else if (selected === null && items.length > 0) setSelected(items[0]);
  }, [items, selected, selectedTaskId, inProgressTasks, statusFilter]);

  const tasksById = useMemo(() => {
    const map: Record<string, Task> = {};
    for (const t of tasks) map[t.id] = t;
    return map;
  }, [tasks]);

  const applyItem = (updated: Item) => {
    setSelected(updated);
    setAllItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    refresh();
  };

  const lockActions = () => {
    const now = Date.now();
    setActionUnlockAt(now + INBOX_ACTION_COOLDOWN_MS);
    setActionClock(now);
  };

  const runAction = async (fn: () => Promise<Item>) => {
    if (actionsLocked) return;
    setActionBusy(true);
    setActionError(null);
    try {
      applyItem(await fn());
      lockActions();
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setActionBusy(false);
    }
  };

  const sendReply = async (override?: string, permission?: string, answers?: Record<string, string | string[]>) => {
    const text = (override ?? replyText).trim();
    if (!selected || (!text && !permission && !answers) || replyBusy || actionsLocked) return;
    setReplyBusy(true);
    setReplyError(null);
    setReplyOk(null);
    try {
      const res = answers ? await api.replyAnswers(selected.id, answers) : permission ? await api.replyPermission(selected.id, permission) : await api.replyItem(selected.id, text);
      setReplyOk(`Sent to ${res.sent_to}`);
      setReplyText("");
      setGrillOpen(false);
      applyItem({ ...selected, status: "resolved", resolved_ms: Date.now() });
      lockActions();
    } catch (err) {
      setReplyError(errText(err));
    } finally {
      setReplyBusy(false);
    }
  };

  const openConversation = async () => {
    if (!selected?.source_ref || openBusy) return;
    setOpenBusy(true);
    setActionError(null);
    setAttachCmd(null);
    try {
      const res = await api.openSession(selected.source_ref);
      if (res.url) window.open(res.url, "_blank", "noopener");
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setOpenBusy(false);
    }
  };

  const archiveTask = async (task: Task) => {
    if (actionsLocked) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const updated = await api.archiveTask(task);
      setTasks((prev) => prev.map((entry) => entry.id === updated.id ? updated : entry));
      setSelectedTaskId(null);
      refresh();
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setActionBusy(false);
    }
  };

  const openTaskSession = async (address: string) => {
    if (openBusy) return;
    setOpenBusy(true);
    setActionError(null);
    try {
      const result = await api.openSession(address);
      if (result.url) window.open(result.url, "_blank", "noopener");
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setOpenBusy(false);
    }
  };

  const onReplyKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void sendReply();
    }
  };

  const summarize = async () => {
    if (!selected || summarizeBusy) return;
    setSummarizeBusy(true);
    setActionError(null);
    try {
      applyItem(await api.summarizeItem(selected.id));
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setSummarizeBusy(false);
    }
  };

  const changeFilter = (next: StatusFilter) => {
    if (next === statusFilter) return;
    setStatusFilter(next);
    setSelected(null);
    setSelectedTaskId(null);
  };

  const linkedTask = selected?.task_id ? tasksById[selected.task_id] ?? null : null;
  const selectedTask = selectedTaskId ? inProgressTasks.find((task) => task.id === selectedTaskId) ?? null : null;
  const grillRound = selected && linkedTask && (linkedTask.kind === "grill" || linkedTask.kind === "grill-docs") && !selected.elicitation ? parseGrillRound(selected.summary || selected.body) : [];
  const prUrl = selected ? itemPrUrl(selected.body, linkedTask?.pr_url) : null;
  /** An item the agent is handling reads as "in progress", not "open". */
  const selectedInProgress = selected !== null && isHandlingItem(selected) && selected.status === "open";
  const now = Date.now();
  const refreshStatus = `${loading ? "Refreshing inbox" : error ? "Inbox refresh failed" : "Inbox up to date"}. ${syncRequest === "requesting" ? "Requesting GitHub/GitLab PR sync" : syncRequest === "requested" ? "GitHub/GitLab PR sync requested; completion status unavailable" : syncRequest === "error" ? "GitHub/GitLab PR sync request failed" : "GitHub/GitLab PR sync not requested"}`;

  return (
    <div className="page inbox-page" style={active ? undefined : { display: "none" }}>
      <div className="list-pane" style={{ width: listSize.width }}>
        <div className="list-toolbar">
          <div className="chip-row">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                className={`chip ${statusFilter === f.key ? "chip-active" : ""}`}
                onClick={() => changeFilter(f.key)}
              >
                {f.label}
                <span className="chip-count">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <span className={`inbox-refresh-status ${error || syncRequest === "error" ? "inbox-refresh-error" : ""}`}
            role="status" aria-label={refreshStatus} title={refreshStatus}>
            {loading || syncRequest === "requesting" ? <Spinner /> : error || syncRequest === "error" ? "!" : "✓"}
          </span>
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="item-list">
          {statusFilter === "in-progress" && inProgressTasks.map((task) => (
            <div key={task.id} role="button" tabIndex={0}
              className={`item-row ${selectedTaskId === task.id ? "selected" : ""}`}
              onClick={() => { setSelected(null); setSelectedTaskId(task.id); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(null); setSelectedTaskId(task.id); } }}>
              <span className="item-row-main">
                <span className="item-row-title">{task.title || task.prompt.trim().split("\n")[0] || "Untitled task"}</span>
                <span className="item-row-sub">
                  <span>Task · in progress</span>
                  <AgentRunBadge status={agentRunStatus(task, sessions, terminals)} />
                </span>
              </span>
              <span className="item-row-side">
                <JiraPill jiraKey={task.jira_key} jiraUrl={task.jira_url} />
                <span className="time" title={formatTs(task.created_ms)}>{timeAgo(task.created_ms)}</span>
              </span>
            </div>
          ))}
          {loading && items.length === 0 && (statusFilter !== "in-progress" || inProgressTasks.length === 0) ? (
            <div className="pane-note">
              <Spinner label="Loading…" />
            </div>
          ) : items.length === 0 && (statusFilter !== "in-progress" || inProgressTasks.length === 0) ? (
            <div className="pane-note">{statusFilter === "open" ? "Nothing needs you." : "Nothing here."}</div>
          ) : (
            items.map((item) => {
              const needsYou = item.status === "open" && (item.kind === "question" || item.kind === "plan" || item.kind === "launch" || item.kind === "amendment");
              const snoozed = item.snooze_until_ms !== null && item.snooze_until_ms > Date.now();
              const rowTask = item.task_id ? tasksById[item.task_id] : undefined;
              const rowPr = itemPrUrl(item.body, rowTask?.pr_url);
              return (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  className={`item-row ${needsYou ? "needs-you" : ""} ${selected?.id === item.id ? "selected" : ""}`}
                  onClick={() => { setSelectedTaskId(null); setSelected(item); }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedTaskId(null);
                      setSelected(item);
                    }
                  }}
                >
                  <KindIcon kind={item.kind} />
                  <span className="item-row-main">
                    <span className="item-row-title">{inboxTitle(item, sessions)}</span>
                    <span className="item-row-sub">
                      <span className="kind-label">{item.kind}</span>
                      <span>·</span>
                      <span>{item.structured ? "structured" : "auto-captured"}</span>
                      {item.kind === "pr" && item.status === "open" ? (
                        item.handling === 1 ? (
                          <span className="badge badge-mine">agent working</span>
                        ) : item.ready === 1 ? (
                          <span className={`badge ${item.summary === "ready to merge" ? "badge-ready" : "badge-mine"}`}>{item.summary === "ready to merge" ? "ready to merge" : "ready for review"}</span>
                        ) : (
                          <span className="badge badge-wait">needs work</span>
                        )
                      ) : null}
                    </span>
                  </span>
                  <span className="item-row-side">
                    <span className="time" title={formatTs(item.created_ms)}>
                      {timeAgo(item.created_ms)}
                    </span>
                    {needsYou ? <span className="badge badge-urgent">needs you</span> : null}
                    {snoozed ? <span className="badge badge-snoozed">snoozed</span> : null}
                    <JiraPill jiraKey={rowTask?.jira_key} jiraUrl={rowTask?.jira_url} />
                    {rowPr ? (
                      <a
                        href={rowPr}
                        target="_blank"
                        rel="noreferrer"
                        className="pr-pill"
                        title={rowPr}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {prLabel(rowPr)}
                        <ExternalLinkIcon />
                      </a>
                    ) : null}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <ResizeHandle
        label="Resize inbox list"
        width={listSize.width}
        limits={LIST_LIMITS}
        reserve={DETAIL_MIN_WIDTH}
        onChange={listSize.setWidth}
        onReset={listSize.reset}
      />

      <div className="detail-pane">
        {selectedTask ? (
          <>
            <div className="detail-head">
              <h2 className="detail-title">{selectedTask.title || selectedTask.prompt.trim().split("\n")[0] || "Untitled task"}</h2>
              <div className="detail-meta">
                <span className="chip chip-static status-dispatched">in progress</span>
                <AgentRunBadge status={agentRunStatus(selectedTask, sessions, terminals)} />
                <JiraPill jiraKey={selectedTask.jira_key} jiraUrl={selectedTask.jira_url} />
              </div>
            </div>
            <div className="detail-body"><Markdown text={selectedTask.prompt} className="body-text" /></div>
            <div className="detail-actions">
              <div className="action-row">
                {selectedTask.terminal_address ? (
                  <button className="btn btn-primary" disabled={openBusy} onClick={() => void openTaskSession(selectedTask.terminal_address!)}>
                    {openBusy ? "Opening…" : "View task"}
                  </button>
                ) : <span className="muted">No session available.</span>}
                <RequestArtifact key={selectedTask.id} task={selectedTask} />
                <TaskHistoryButton taskId={selectedTask.id} title={selectedTask.title || selectedTask.prompt.trim().split("\n")[0] || "Untitled task"} version={eventVersion} />
                {selectedTask.branch ? <ForcePrRefresh task={selectedTask} onChecked={refresh} /> : null}
                <button className="btn" disabled={actionsLocked} onClick={() => void archiveTask(selectedTask)} title="Archive this task and its session in Omnigent when it has one">
                  Archive task
                </button>
              </div>
              {actionError ? <div className="inline-error">{actionError}</div> : null}
            </div>
          </>
        ) : !selected ? (
          <div className="pane-note">Select an item to review it.</div>
        ) : (
          <>
            <div className="detail-head">
              <div className="detail-title-row">
                <h2 className="detail-title">{itemDisplayTitle(selected.title)}</h2>
                {prUrl ? (
                  <a href={prUrl} target="_blank" rel="noreferrer" className="btn btn-primary pr-open" title={prUrl}>
                    Open {prLabel(prUrl)}
                    <ExternalLinkIcon />
                  </a>
                ) : null}
              </div>
              <div className="detail-meta">
                <span className="chip chip-static">{selected.kind}</span>
                <span className="chip chip-static">
                  {selected.structured ? "structured report" : "auto-captured"}
                </span>
                {selected.kind === "pr" && selected.status === "open" ? (
                  selected.handling === 1 ? (
                    <span className="badge badge-mine">agent working — {selected.summary || "PR loop"}</span>
                  ) : selected.ready === 1 ? (
                    <span className={`badge ${selected.summary === "ready to merge" ? "badge-ready" : "badge-mine"}`}>{selected.summary === "ready to merge" ? "ready to merge" : "ready for review"}</span>
                  ) : (
                    <span className="badge badge-wait">needs work — {selected.summary || "see body"}</span>
                  )
                ) : null}
                <span className={`chip chip-static status-${selectedInProgress ? "dispatched" : selected.status}`}>
                  {selectedInProgress ? "in progress" : selected.status === "resolved" ? "acknowledged" : selected.status}
                </span>
                {linkedTask ? (
                  <span className="meta-task">
                    Task: <strong>{linkedTask.title || linkedTask.prompt.trim().split("\n")[0].slice(0, 120) || "Untitled task"}</strong>
                    <JiraPill jiraKey={linkedTask.jira_key} jiraUrl={linkedTask.jira_url} />
                  </span>
                ) : null}
                <span className="time muted" title={formatTs(selected.created_ms)}>
                  {timeAgo(selected.created_ms)}
                </span>
              </div>
            </div>

            <div className="detail-body">
              <ItemBody item={selected} />
              {selected.context ? (
                <details className="context-drawer">
                  <summary>{selected.kind === "digest" && !selected.task_id ? "Analysis evidence" : "Recent agent output"}</summary>
                  <pre className="body-text body-raw">{selected.context}</pre>
                </details>
              ) : null}
              {!selected.summary && selected.kind === "question" ? (
                <div className="summarize-row">
                  <button className="btn" onClick={() => void summarize()} disabled={summarizeBusy}>
                    {summarizeBusy ? <Spinner /> : null}
                    {summarizeBusy ? "Summarizing…" : "Summarize"}
                  </button>
                  <span className="muted">Runs an LLM summary of the body (~10s).</span>
                </div>
              ) : null}
            </div>

            <div className={`detail-actions${grillRound.length > 0 ? " grill-actions" : ""}`}>
              <div className="action-row">
                {selected.source_ref ? (
                  <button className="btn btn-primary" onClick={() => void openConversation()} disabled={openBusy}>
                    {openBusy ? <Spinner /> : null}
                    {openBusy ? "Opening…" : "Open conversation"}
                  </button>
                ) : null}
                {selected.kind === "plan" && selected.status === "open" && linkedTask?.kind === "spec" ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => void runAction(async () => { await api.approvePlan(linkedTask.id); return api.resolveItem(selected.id); })}
                    disabled={actionsLocked}
                    title="Create one task per sub-project, each carrying the contract"
                  >
                    {actionBusy ? <Spinner /> : null}
                    Approve plan
                  </button>
                ) : null}
                {selected.kind === "launch" && selected.status === "open" && linkedTask ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => linkedTask.target && linkedTask.repo_path
                      ? void runAction(async () => { await api.dispatchTask(linkedTask.id, {}); return api.resolveItem(selected.id); })
                      : void (window.location.hash = "/tasks")}
                    disabled={actionsLocked}
                    title={linkedTask.target && linkedTask.repo_path ? "Start the agent on this task" : "Pick a repository and a harness on the task first"}
                  >
                    {actionBusy ? <Spinner /> : null}
                    {linkedTask.target && linkedTask.repo_path ? "Launch" : "Open task"}
                  </button>
                ) : null}
                {selected.kind === "amendment" && selected.status === "open" ? (
                  <>
                    <button className="btn btn-primary" disabled={actionsLocked} title="Write this amendment into the Jira ticket and onto the task"
                      onClick={() => void runAction(() => api.applyAmendment(selected.id))}>
                      {actionBusy ? <Spinner /> : null}Apply to Jira
                    </button>
                    <button className="btn" disabled={actionsLocked}
                      onClick={() => void runAction(() => api.rejectAmendment(selected.id))}>Reject</button>
                  </>
                ) : null}
                {selected.kind === "pr" && linkedTask?.branch ? <ForcePrRefresh task={linkedTask} onChecked={refresh} /> : null}
                {linkedTask ? <RequestArtifact key={linkedTask.id} task={linkedTask} /> : null}
                {linkedTask ? <TaskHistoryButton taskId={linkedTask.id} title={linkedTask.title || linkedTask.prompt.trim().split("\n")[0] || "Untitled task"} version={eventVersion} /> : null}
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.resolveItem(selected.id))}
                  disabled={actionsLocked || selected.status === "resolved"}
                >
                  Acknowledge
                </button>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.archiveItem(selected.id))}
                  disabled={actionsLocked || selected.status === "archived"}
                >
                  Archive
                </button>
                <span className="action-label">Snooze:</span>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.snoozeItem(selected.id, snoozeUntil("1h")))}
                  disabled={actionsLocked}
                >
                  1h
                </button>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.snoozeItem(selected.id, snoozeUntil("4h")))}
                  disabled={actionsLocked}
                >
                  4h
                </button>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.snoozeItem(selected.id, snoozeUntil("tomorrow")))}
                  disabled={actionsLocked}
                >
                  Tomorrow
                </button>
              </div>
              {actionError ? <div className="inline-error">{actionError}</div> : null}
              {attachCmd ? (
                <div className="inline-ok">
                  Open it yourself: <code className="mono">{attachCmd}</code>
                </div>
              ) : null}

              {selected.kind === "launch" || selected.kind === "amendment" ? null : <div className="reply-block">
                {grillRound.length > 0 ? <>
                  <button type="button" className="btn btn-primary"
                    title="Open the interview round in a modal"
                    onClick={() => setGrillOpen(true)}>
                    {selected.status === "open" ? "Answer" : "View"} questions ({grillRound.length})
                  </button>
                  {grillOpen ? <GrillRoundDialog
                    key={selected.id + selected.updated_ms}
                    questions={grillRound}
                    title={linkedTask?.title || itemDisplayTitle(selected.title)}
                    disabled={replyBusy || actionsLocked || selected.status !== "open"}
                    error={replyError}
                    onSend={(answers) => sendReply(formatGrillAnswers(grillRound, answers))}
                    onClose={() => setGrillOpen(false)}
                  /> : null}
                </> : replyQuestions(selected.elicitation).length > 0 ? <>
                  <QuestionReply key={selected.id + selected.elicitation}
                    questions={replyQuestions(selected.elicitation)} disabled={replyBusy || actionsLocked || selected.status !== "open"}
                    onSend={(answers) => sendReply("", undefined, answers)} />
                  {replyError ? <span className="inline-error">{replyError}</span> : null}
                </> : <>
                {(() => {
                  try {
                    const elicitation = selected.elicitation ? JSON.parse(selected.elicitation) as { kind?: string; persistPattern?: string } : null;
                    if (elicitation?.kind !== "permission") return null;
                    const choices = [
                      { value: "approve", label: "Approve" },
                      ...(elicitation.persistPattern ? [
                        { value: "session", label: `Allow commands starting with ${elicitation.persistPattern} for this session` },
                        { value: "always", label: `Always allow commands starting with ${elicitation.persistPattern}` },
                      ] : []),
                      { value: "reject", label: "Reject" },
                    ];
                    return <div className="option-row">{choices.map(({ value, label }) => (
                      <button key={value} className={value === "approve" ? "btn btn-primary" : "btn option-btn"}
                        onClick={() => void sendReply("", value)} disabled={replyBusy || actionsLocked || selected.status !== "open"}>{label}</button>
                    ))}</div>;
                  } catch { return null; }
                })()}
                {(() => {
                  let options: string[] = [];
                  try {
                    options = selected.options ? (JSON.parse(selected.options) as string[]) : [];
                  } catch {
                    options = [];
                  }
                  return options.length > 0 ? (
                    <div className="option-row">
                      {options.map((opt) => (
                        <button
                          key={opt}
                          className="btn option-btn"
                          onClick={() => void sendReply(opt)}
                          disabled={replyBusy || actionsLocked || selected.status !== "open"}
                        >
                          {opt}
                        </button>
                      ))}
                      <span className="muted">…or type below</span>
                    </div>
                  ) : null;
                })()}
                <textarea
                  ref={replyRef}
                  className="reply-input"
                  placeholder="Reply to the agent's terminal…  (Cmd/Ctrl+Enter to send)"
                  value={replyText}
                  rows={3}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={onReplyKeyDown}
                />
                <div className="reply-foot">
                  <button className="btn btn-primary" onClick={() => void sendReply()} disabled={replyBusy || actionsLocked || !replyText.trim()}>
                    {replyBusy ? <Spinner /> : null}
                    {replyBusy ? "Sending…" : "Send & acknowledge"}
                  </button>
                  {replyOk ? <span className="inline-ok">{replyOk}</span> : null}
                  {replyError ? <span className="inline-error">{replyError}</span> : null}
                  {selected.snooze_until_ms !== null && selected.snooze_until_ms > now ? (
                    <span className="muted">Snoozed until {formatTs(selected.snooze_until_ms)}</span>
                  ) : null}
                </div>
                </>}
              </div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
