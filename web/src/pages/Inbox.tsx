// Inbox — mail-style two-pane dispatch-and-review view.

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { api } from "../api";
import type { Item, Task } from "../types";
import { errText, formatTs, snoozeUntil, timeAgo } from "../util";
import { KindIcon, Spinner } from "../ui";
import { Markdown } from "../markdown";

type StatusFilter = "open" | "resolved" | "archived";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
  { key: "archived", label: "Archived" },
];

export function InboxPage({ eventVersion, refresh }: { eventVersion: number; refresh: () => void }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [items, setItems] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);

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
    Promise.all([api.listItems({ status: statusFilter }), api.listTasks()])
      .then(([itemList, taskList]) => {
        if (cancelled) return;
        setItems(itemList);
        setTasks(taskList);
        setError(null);
        setSelected((prev) => (prev ? itemList.find((i) => i.id === prev.id) ?? prev : prev));
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
  }, [statusFilter, eventVersion]);

  // Auto-select the first row when nothing is selected.
  useEffect(() => {
    if (selected === null && items.length > 0) setSelected(items[0]);
  }, [items, selected]);

  const tasksById = useMemo(() => {
    const map: Record<string, Task> = {};
    for (const t of tasks) map[t.id] = t;
    return map;
  }, [tasks]);

  const applyItem = (updated: Item) => {
    setSelected(updated);
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
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

  const sendReply = async (override?: string) => {
    const text = (override ?? replyText).trim();
    if (!selected || !text || replyBusy) return;
    setReplyBusy(true);
    setReplyError(null);
    setReplyOk(null);
    try {
      const res = await api.replyItem(selected.id, text);
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
      if (!res.opened && res.attach_command) setAttachCmd(res.attach_command);
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
  };

  const linkedTask = selected?.task_id ? tasksById[selected.task_id] ?? null : null;
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
              </button>
            ))}
          </div>
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="item-list">
          {loading && items.length === 0 ? (
            <div className="pane-note">
              <Spinner label="Loading…" />
            </div>
          ) : items.length === 0 ? (
            <div className="pane-note">{statusFilter === "open" ? "Nothing needs you." : "Nothing here."}</div>
          ) : (
            items.map((item) => {
              const needsYou = item.status === "open" && item.kind === "question";
              const snoozed = item.snooze_until_ms !== null && item.snooze_until_ms > Date.now();
              return (
                <button
                  key={item.id}
                  className={`item-row ${needsYou ? "needs-you" : ""} ${selected?.id === item.id ? "selected" : ""}`}
                  onClick={() => setSelected(item)}
                >
                  <KindIcon kind={item.kind} />
                  <span className="item-row-main">
                    <span className="item-row-title">{item.title}</span>
                    <span className="item-row-sub">
                      <span className="kind-label">{item.kind}</span>
                      <span>·</span>
                      <span>{item.structured ? "structured" : "auto-captured"}</span>
                      {item.kind === "pr" && item.status === "open" ? (
                        item.ready === 1 ? (
                          <span className="badge badge-ready">ready for review</span>
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
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="detail-pane">
        {!selected ? (
          <div className="pane-note">Select an item to review it.</div>
        ) : (
          <>
            <div className="detail-head">
              <h2 className="detail-title">{selected.title}</h2>
              <div className="detail-meta">
                <span className="chip chip-static">{selected.kind}</span>
                <span className="chip chip-static">
                  {selected.structured ? "structured report" : "auto-captured"}
                </span>
                {selected.kind === "pr" && selected.status === "open" ? (
                  selected.ready === 1 ? (
                    <span className="badge badge-ready">ready for review</span>
                  ) : (
                    <span className="badge badge-wait">needs work — {selected.summary || "see body"}</span>
                  )
                ) : null}
                <span className={`chip chip-static status-${selected.status}`}>{selected.status}</span>
                {linkedTask ? (
                  <span className="meta-task">
                    Task: <strong>{linkedTask.title}</strong>
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
                <pre className="body-text body-raw">{selected.body}</pre>
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
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
