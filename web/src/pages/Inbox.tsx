// Inbox — mail-style two-pane dispatch-and-review view.

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { api } from "../api";
import type { Item, SessionInfo, Task } from "../types";
import { errText, formatTs, itemPrUrl, prLabel, snoozeUntil, timeAgo } from "../util";
import { ExternalLinkIcon, KindIcon, Spinner } from "../ui";
import { Markdown } from "../markdown";
import { inProgressInboxItems, inProgressInboxTasks, selectedInboxItem } from "../inbox-selection";
import { useVisibleInboxItems } from "../use-visible-inbox-items";
import { inboxTitle } from "../inbox-title";
import { replyQuestions } from "../question-reply";
import { QuestionReply } from "../QuestionReply";

type StatusFilter = "open" | "snoozed" | "in-progress";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "snoozed", label: "Snoozed" },
  { key: "in-progress", label: "In progress" },
];

export function InboxPage({ eventVersion, refresh, onSeen }: { eventVersion: number; refresh: () => void; onSeen: (items: Item[]) => void }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const [replyText, setReplyText] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyOk, setReplyOk] = useState<string | null>(null);
  const [summarizeBusy, setSummarizeBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  const [attachCmd, setAttachCmd] = useState<string | null>(null);

  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.listItems(), api.listTasks(), api.listSessions().catch(() => [] as SessionInfo[])])
      .then(([itemList, taskList, sessionList]) => {
        if (cancelled) return;
        setAllItems(itemList);
        setTasks(taskList);
        setSessions(sessionList);
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
  }, [eventVersion, statusFilter]);

  // Opening the inbox re-checks PRs: merged ones get resolved (server
  // broadcasts the changes, which bumps eventVersion and reloads the list).
  useEffect(() => {
    const sync = () => { if (document.visibilityState === "visible") void api.syncPrs().catch(() => undefined); };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const visibleItems = useVisibleInboxItems(allItems);
  const snoozedItems = useVisibleInboxItems(allItems, "snoozed");
  const inProgressItems = useMemo(() => inProgressInboxItems(allItems, tasks), [allItems, tasks]);
  const inProgressTasks = useMemo(() => inProgressInboxTasks(tasks), [tasks]);
  const openItems = useMemo(() => visibleItems.filter((i) => i.status === "open"), [visibleItems]);
  const items = statusFilter === "snoozed" ? snoozedItems : statusFilter === "in-progress" ? inProgressItems : openItems;
  useEffect(() => {
    const acknowledge = () => {
      if (!loading && !error && statusFilter === "open" && document.visibilityState === "visible") onSeen(items);
    };
    acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    return () => document.removeEventListener("visibilitychange", acknowledge);
  }, [items, loading, error, statusFilter, onSeen]);

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

  const runAction = async (fn: () => Promise<Item>) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      applyItem(await fn());
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setActionBusy(false);
    }
  };

  const sendReply = async (override?: string, permission?: string, answers?: Record<string, string | string[]>) => {
    const text = (override ?? replyText).trim();
    if (!selected || (!text && !permission && !answers) || replyBusy) return;
    setReplyBusy(true);
    setReplyError(null);
    setReplyOk(null);
    try {
      const res = answers ? await api.replyAnswers(selected.id, answers) : permission ? await api.replyPermission(selected.id, permission) : await api.replyItem(selected.id, text);
      setReplyOk(`Sent to ${res.sent_to}`);
      setReplyText("");
      applyItem({ ...selected, status: "resolved", resolved_ms: Date.now() });
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

  const archiveTask = async (task: Task, cleanSession = false) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const updated = cleanSession ? await api.archiveTaskSession(task.id) : await api.patchTask(task.id, { status: "archived" });
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
  const prUrl = selected ? itemPrUrl(selected.body, linkedTask?.pr_url) : null;
  const now = Date.now();

  return (
    <div className="page inbox-page">
      <div className="list-pane">
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
                <span className="item-row-sub">Task · in progress</span>
              </span>
              <span className="item-row-side"><span className="time" title={formatTs(task.created_ms)}>{timeAgo(task.created_ms)}</span></span>
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
              const needsYou = item.status === "open" && item.kind === "question";
              const snoozed = item.snooze_until_ms !== null && item.snooze_until_ms > Date.now();
              const rowPr = itemPrUrl(item.body, item.task_id ? tasksById[item.task_id]?.pr_url : null);
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
                        item.ready === 1 ? (
                          <span className="badge badge-ready">{item.summary === "ready to merge" ? "ready to merge" : "ready for review"}</span>
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

      <div className="detail-pane">
        {selectedTask ? (
          <>
            <div className="detail-head">
              <h2 className="detail-title">{selectedTask.title || selectedTask.prompt.trim().split("\n")[0] || "Untitled task"}</h2>
              <div className="detail-meta"><span className="chip chip-static status-dispatched">in progress</span></div>
            </div>
            <div className="detail-body"><Markdown text={selectedTask.prompt} className="body-text" /></div>
            <div className="detail-actions">
              <div className="action-row">
                {selectedTask.terminal_address ? (
                  <button className="btn btn-primary" disabled={openBusy} onClick={() => void openTaskSession(selectedTask.terminal_address!)}>
                    {openBusy ? "Opening…" : "View task"}
                  </button>
                ) : <span className="muted">No session available.</span>}
                <button className="btn" disabled={actionBusy} onClick={() => void archiveTask(selectedTask)} title="Archive this task; its session keeps running">
                  Archive task
                </button>
                {selectedTask.terminal_address ? <button className="btn" disabled={actionBusy} onClick={() => void archiveTask(selectedTask, true)} title="Archive this task and its session">
                  Archive &amp; clean session
                </button> : null}
              </div>
              <div className="muted">Archive task leaves the session running. Archive &amp; clean session archives it in Omnigent.</div>
              {actionError ? <div className="inline-error">{actionError}</div> : null}
            </div>
          </>
        ) : !selected ? (
          <div className="pane-note">Select an item to review it.</div>
        ) : (
          <>
            <div className="detail-head">
              <div className="detail-title-row">
                <h2 className="detail-title">{selected.title}</h2>
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
                  selected.ready === 1 ? (
                    <span className="badge badge-ready">{selected.summary === "ready to merge" ? "ready to merge" : "ready for review"}</span>
                  ) : (
                    <span className="badge badge-wait">needs work — {selected.summary || "see body"}</span>
                  )
                ) : null}
                <span className={`chip chip-static status-${selected.status}`}>{selected.status}</span>
                {linkedTask ? (
                  <span className="meta-task">
                    Task: <strong>{linkedTask.title || linkedTask.prompt.trim().split("\n")[0].slice(0, 120) || "Untitled task"}</strong>
                    {linkedTask.jira_url ? (
                      <a href={linkedTask.jira_url} target="_blank" rel="noreferrer" className="meta-link">
                        {linkedTask.jira_key}
                      </a>
                    ) : null}
                  </span>
                ) : null}
                <span className="time muted" title={formatTs(selected.created_ms)}>
                  {timeAgo(selected.created_ms)}
                </span>
              </div>
            </div>

            <div className="detail-body">
              {selected.structured ? (
                <>
                  {selected.summary ? <Markdown text={selected.summary} className="body-text" /> : null}
                  {selected.body && selected.body !== selected.summary ? (
                    <Markdown text={selected.body} className="body-text" />
                  ) : null}
                </>
              ) : (
                <>
                  {/* Auto-captured: an LLM summary (if any) above the raw body. */}
                  {selected.summary ? <Markdown text={selected.summary} className="body-text" /> : null}
                  <pre className="body-text body-raw">{selected.body}</pre>
                </>
              )}
              {selected.context ? (
                <details className="context-drawer">
                  <summary>Recent agent output</summary>
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

            <div className="detail-actions">
              <div className="action-row">
                {selected.source_ref ? (
                  <button className="btn btn-primary" onClick={() => void openConversation()} disabled={openBusy}>
                    {openBusy ? <Spinner /> : null}
                    {openBusy ? "Opening…" : "Open conversation"}
                  </button>
                ) : null}
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.resolveItem(selected.id))}
                  disabled={actionBusy || selected.status === "resolved"}
                >
                  Resolve
                </button>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.archiveItem(selected.id))}
                  disabled={actionBusy || selected.status === "archived"}
                >
                  Archive
                </button>
                <span className="action-label">Snooze:</span>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.snoozeItem(selected.id, snoozeUntil("1h")))}
                  disabled={actionBusy}
                >
                  1h
                </button>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.snoozeItem(selected.id, snoozeUntil("tomorrow")))}
                  disabled={actionBusy}
                >
                  Tomorrow
                </button>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.snoozeItem(selected.id, snoozeUntil("nextweek")))}
                  disabled={actionBusy}
                >
                  Next week
                </button>
              </div>
              {actionError ? <div className="inline-error">{actionError}</div> : null}
              {attachCmd ? (
                <div className="inline-ok">
                  Open it yourself: <code className="mono">{attachCmd}</code>
                </div>
              ) : null}

              <div className="reply-block">
                {replyQuestions(selected.elicitation).length > 0 ? <>
                  <QuestionReply key={selected.id + selected.elicitation}
                    questions={replyQuestions(selected.elicitation)} disabled={replyBusy || selected.status !== "open"}
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
                        onClick={() => void sendReply("", value)} disabled={replyBusy || selected.status !== "open"}>{label}</button>
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
                          disabled={replyBusy || selected.status !== "open"}
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
                  <button className="btn btn-primary" onClick={() => void sendReply()} disabled={replyBusy || !replyText.trim()}>
                    {replyBusy ? <Spinner /> : null}
                    {replyBusy ? "Sending…" : "Send & resolve"}
                  </button>
                  {replyOk ? <span className="inline-ok">{replyOk}</span> : null}
                  {replyError ? <span className="inline-error">{replyError}</span> : null}
                  {selected.snooze_until_ms !== null && selected.snooze_until_ms > now ? (
                    <span className="muted">Snoozed until {formatTs(selected.snooze_until_ms)}</span>
                  ) : null}
                </div>
                </>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
