import { useEffect, useState } from "react";
import { api } from "../api";
import { errText } from "../util";

type Activity = Awaited<ReturnType<typeof api.dailyActivity>>[number];

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function DailyPage({ eventVersion }: { eventVersion: number }) {
  const [date, setDate] = useState(() => localDate(new Date()));
  const [events, setEvents] = useState<Activity[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!date) { setEvents([]); return; }
    const [year, month, day] = date.split("-").map(Number);
    const start = new Date(year, month - 1, day);
    const end = new Date(year, month - 1, day + 1);
    let cancelled = false;
    setLoading(true); setError("");
    api.dailyActivity(start.getTime(), end.getTime()).then((items) => { if (!cancelled) setEvents(items); }).catch((e: unknown) => { if (!cancelled) { setEvents([]); setError(errText(e)); } }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, eventVersion]);
  const groups = new Map<string, Activity[]>();
  for (const event of events) groups.set(event.task_id, [...(groups.get(event.task_id) ?? []), event]);
  return <div className="page">
    <div className="page-scroll">
      <section className="daily-page">
        <h1>Daily standup</h1>
        <p className="muted">Activity recorded on professional tasks for the selected day. Times use your local time zone.</p>
        <label className="daily-date">Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        {loading ? <p>Loading activity…</p> : null}
        {!loading && date && !error && groups.size === 0 ? <p className="muted">No professional task activity recorded for this day.</p> : null}
        {!loading && [...groups.values()].map((items) => {
          const task = items[0];
          return <article className="daily-task" key={task.task_id}>
            <h2>{task.title.trim() || task.prompt.trim().split("\n")[0].slice(0, 80) || "Untitled task"}</h2>
            <p className="muted">{task.repo_name} {task.jira_url && task.jira_key ? <> · <a href={task.jira_url} target="_blank" rel="noreferrer">{task.jira_key}</a></> : null} {task.pr_url ? <> · <a href={task.pr_url} target="_blank" rel="noreferrer">Pull request</a></> : null}</p>
            <ul>{items.map((event) => <li key={event.id}><time>{new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> {event.message}</li>)}</ul>
          </article>;
        })}
      </section>
    </div>
  </div>;
}
