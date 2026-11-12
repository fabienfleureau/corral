// Task history — the timeline of what happened to one task, opened as a modal
// from the inbox and the tasks page.
//
// Native <dialog> opened with showModal(): the browser owns the top layer, the
// inert page, focus containment, Esc and focus return to the invoker, so none
// of that is reimplemented here (see the `dialog` guide).

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import type { TaskEvent, TaskEventKind } from "./types";
import { errText, formatTs } from "./util";
import { Spinner } from "./ui";

const ICONS: Record<TaskEventKind, ReactNode> = {
  created: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  updated: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  status: (
    <>
      <path d="M4 6h11l-2.5-2.5" />
      <path d="M20 18H9l2.5 2.5" />
      <path d="M4 6v12" />
      <path d="M20 18V6" />
    </>
  ),
  prompt: (
    <>
      <path d="M4 12h13" />
      <path d="M13 6l6 6-6 6" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.2a2.8 2.8 0 0 1 5.5.9c0 1.9-2.8 2.4-2.8 4" />
      <path d="M12 17.2h.01" />
    </>
  ),
  jira: (
    <>
      <path d="M4 8a3 3 0 0 1 3-3h10a3 3 0 0 1 0 6H7a3 3 0 0 0 0 6h10" />
      <path d="M9 5v6" />
    </>
  ),
  pr: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5V21" />
      <path d="M15 6h1a2 2 0 0 1 2 2v7.5" />
    </>
  ),
  session: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <path d="M13 15h5" />
    </>
  ),
};

const KIND_LABELS: Record<TaskEventKind, string> = {
  created: "created",
  updated: "updated",
  status: "status",
  prompt: "prompt",
  question: "question",
  jira: "jira",
  pr: "pr",
  session: "session",
};

/** Preferred order of the detail keys, so a prompt shows its text first. */
const DETAIL_ORDER = ["text", "from", "to", "field", "pr", "key", "session", "source", "chars", "error"];

function detailRows(event: TaskEvent): [string, string][] {
  if (!event.data) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return [];
  }
  // The message already carries the from → to of a field change.
  const hidden = new Set(["from", "to"]);
  const keys = Object.keys(parsed).filter((k) => !hidden.has(k) && parsed[k] !== null && parsed[k] !== "");
  keys.sort((a, b) => {
    const ai = DETAIL_ORDER.indexOf(a);
    const bi = DETAIL_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? bi : 99);
  });
  return keys.map((k) => {
    const value = parsed[k];
    return [k, typeof value === "string" ? value : JSON.stringify(value)] as [string, string];
  });
}

export function TaskHistoryDialog({ taskId, title, version = 0, onClose }: { taskId: string; title: string; version?: number; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingId = useId();
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // Light dismiss for browsers without `closedby` (Safari). Test the pointer
    // position, not the target: the dialog is also the target for its padding,
    // and a text-selection drag ending on the backdrop must not dismiss.
    if ("closedBy" in HTMLDialogElement.prototype) return;
    let pressedOutside = false;
    const outside = (ev: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom;
    };
    const down = (ev: PointerEvent) => { pressedOutside = outside(ev); };
    const up = (ev: PointerEvent) => { if (pressedOutside && outside(ev)) dialog.close(); };
    dialog.addEventListener("pointerdown", down);
    dialog.addEventListener("pointerup", up);
    return () => {
      dialog.removeEventListener("pointerdown", down);
      dialog.removeEventListener("pointerup", up);
    };
  }, []);

  // Refetched whenever the app sees a change (a run answering, a PR moving):
  // an open history follows the task instead of freezing at open time.
  useEffect(() => {
    let cancelled = false;
    api.taskEvents(taskId)
      .then((list) => { if (!cancelled) { setEvents(list); setError(null); } })
      .catch((err: unknown) => { if (!cancelled) setError(errText(err)); });
    return () => { cancelled = true; };
  }, [taskId, version]);

  // Grouped by calendar day: a timeline of a long task reads as "what happened
  // on which day", and each row then only needs a clock time.
  const days = useMemo(() => {
    const groups: { key: string; label: string; events: TaskEvent[] }[] = [];
    for (const event of events ?? []) {
      const label = new Date(event.ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      const last = groups.at(-1);
      if (last && last.label === label) last.events.push(event);
      else groups.push({ key: `${label}#${event.id}`, label, events: [event] });
    }
    return groups;
  }, [events]);

  return (
    <dialog
      ref={dialogRef}
      className="history-dialog"
      aria-labelledby={headingId}
      {...({ closedby: "any" } as Record<string, string>)}
      onClose={onClose}
    >
      <div className="history-head">
        <div>
          <h2 id={headingId} className="history-title">History</h2>
          <p className="history-sub">{title}</p>
        </div>
        <button type="button" className="btn" autoFocus onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      </div>

      <div className="history-body">
        {error ? <div className="inline-error">{error}</div> : null}
        {!error && events === null ? <div className="pane-note"><Spinner label="Loading history…" /></div> : null}
        {!error && events !== null && events.length === 0 ? (
          <div className="pane-note">No history recorded for this task yet.</div>
        ) : null}
        {days.map((day) => (
          <section className="history-day" key={day.key}>
            <h3 className="history-day-label">{day.label}</h3>
            <ol className="history-list">
              {day.events.map((event) => {
                const rows = detailRows(event);
                return (
                  <li className="history-event" data-kind={event.kind} key={event.id}>
                    <span className="history-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        {ICONS[event.kind]}
                      </svg>
                    </span>
                    <div className="history-main">
                      <div className="history-line">
                        <span className="history-message">{event.message}</span>
                        <span className="history-kind" data-kind={event.kind}>{KIND_LABELS[event.kind]}</span>
                        <time className="time history-time" dateTime={new Date(event.ts).toISOString()} title={formatTs(event.ts)}>
                          {new Date(event.ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                        </time>
                      </div>
                      {rows.length > 0 ? (
                        <details className="history-detail">
                          <summary>Details</summary>
                          <dl>
                            {rows.map(([key, value]) => (
                              <div className="history-detail-row" key={key}>
                                <dt>{key.replace(/_/g, " ")}</dt>
                                <dd className="mono">{value}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </dialog>
  );
}

/** The button + modal pair: each task row renders one, and only the open one
 *  mounts a dialog (so no history is fetched until it is asked for). */
export function TaskHistoryButton({ taskId, title, label = "History", version = 0 }: { taskId: string; title: string; label?: string; version?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} title="Every recorded event on this task">
        {label}
      </button>
      {open ? <TaskHistoryDialog taskId={taskId} title={title} version={version} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
