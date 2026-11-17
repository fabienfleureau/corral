import { useEffect, useId, useState } from "react";
import { api } from "../api";
import type { DailyActivity, Favorite } from "../types";
import { favoritesFor } from "../favorite-context";
import { taskFocusHash } from "../selection-task";
import { errText } from "../util";
import { Spinner } from "../ui";

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayInterval(value: string): { start: number; end: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);
  return Number.isNaN(start.getTime()) ? null : { start: start.getTime(), end: end.getTime() };
}

export function DailyPage({ eventVersion }: { eventVersion: number }) {
  const [date, setDate] = useState(() => localDate(new Date()));
  const [events, setEvents] = useState<DailyActivity[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [harnesses, setHarnesses] = useState<string[] | null>(null);
  const [favorite, setFavorite] = useState("");
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [summaryDone, setSummaryDone] = useState(false);
  const favoriteId = useId();

  useEffect(() => {
    api.getConfig().then((cfg) => setFavorites(favoritesFor(cfg.favorites ?? [], "professional"))).catch(() => undefined);
    // An empty catalog from a worker that did not answer is not evidence that
    // the favorites are unavailable: let the dispatch report a real failure.
    api.listHarnesses().then((res) => setHarnesses(res.harnesses.length ? res.harnesses.map((h) => h.harness) : null)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!favorite && favorites.length > 0) setFavorite(favorites[0].name);
  }, [favorites, favorite]);

  useEffect(() => {
    if (!date) { setEvents([]); return; }
    const interval = dayInterval(date);
    if (!interval) { setEvents([]); return; }
    let cancelled = false;
    setLoading(true); setError(""); setSummaryDone(false);
    api.dailyActivity(interval.start, interval.end).then((items) => { if (!cancelled) setEvents(items); }).catch((e: unknown) => { if (!cancelled) { setEvents([]); setError(errText(e)); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, eventVersion]);

  const summarize = async () => {
    const interval = dayInterval(date);
    if (!interval || !favorite || summarizing) return;
    setSummarizing(true); setSummaryError(""); setSummaryDone(false);
    try {
      await api.summarizeDaily({ start: interval.start, end: interval.end, date, favorite });
      setSummaryDone(true);
    } catch (e) {
      setSummaryError(errText(e));
    } finally {
      setSummarizing(false);
    }
  };

  const groups = new Map<string, DailyActivity[]>();
  for (const event of events) groups.set(event.task_id, [...(groups.get(event.task_id) ?? []), event]);
  const selectedFavorite = favorites.find((f) => f.name === favorite) ?? null;
  const favoriteUnavailable = !!selectedFavorite && harnesses !== null && !harnesses.includes(selectedFavorite.harness);
  return <div className="page">
    <div className="page-scroll">
      <section className="daily-page">
        <h1>Daily standup</h1>
        <p className="muted">Activity recorded on professional tasks for the selected day. Times use your local time zone.</p>
        <div className="daily-controls">
          <label className="daily-date">Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          {favorites.length > 0 ? (
            <label className="daily-date" htmlFor={favoriteId}>Summarize with
              <select id={favoriteId} value={favorite} onChange={(e) => { setFavorite(e.target.value); setSummaryError(""); setSummaryDone(false); }}>
                {favorites.map((f) => <option key={f.name} value={f.name} disabled={harnesses !== null && !harnesses.includes(f.harness)}>{f.name} — {f.harness}</option>)}
              </select>
            </label>
          ) : null}
          <button className="btn btn-primary" disabled={summarizing || !selectedFavorite || !dayInterval(date) || events.length === 0 || favoriteUnavailable} onClick={() => void summarize()}>
            {summarizing ? <Spinner /> : null}
            {summarizing ? "Starting…" : "Summarize day"}
          </button>
        </div>
        {favorites.length === 0 ? <p className="muted">Add a professional favorite in <a href="#/settings">Settings</a> to summarize this day with an agent.</p> : null}
        {summaryError ? <p className="inline-error" role="alert">{summaryError}</p> : null}
        {summaryDone ? <p className="inline-ok" role="status">Summary task started. <a href="#/inbox">Open inbox</a></p> : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        {loading && events.length === 0 ? <p>Loading activity…</p> : null}
        {!loading && date && !error && groups.size === 0 ? <p className="muted">No professional task activity recorded for this day.</p> : null}
        {/* Keep the last activity visible while refreshing: removing it collapses
            the scroll container and sends the reader back to the top. */}
        {[...groups.values()].map((items) => {
          const task = items[0];
          const title = task.title.trim() || task.prompt.trim().split("\n")[0].slice(0, 80) || "Untitled task";
          return <article className="daily-task" key={task.task_id}>
            <h2><a className="daily-task-link" href={taskFocusHash(task.task_id)}>{title}</a></h2>
            <p className="muted">{task.repo_name} {task.jira_url && task.jira_key ? <> · <a href={task.jira_url} target="_blank" rel="noreferrer">{task.jira_key}</a></> : null} {task.pr_url ? <> · <a href={task.pr_url} target="_blank" rel="noreferrer">Pull request</a></> : null} {task.session_url ? <> · <a href={task.session_url} target="_blank" rel="noreferrer" title={task.terminal_address ?? undefined}>Session</a></> : null}</p>
            <ul>{items.map((event) => <li key={event.id}><time>{new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> {event.message}</li>)}</ul>
          </article>;
        })}
      </section>
    </div>
  </div>;
}
