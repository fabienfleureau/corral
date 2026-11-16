import { useEffect, useState } from "react";
import { api } from "../api";
import { errText } from "../util";

type Activity = Awaited<ReturnType<typeof api.dailyActivity>>[number];

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function DailyPage({ eventVersion }: { eventVersion: number }) {
  const [progress, setProgress] = useState<Awaited<ReturnType<typeof api.progression>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.progression().then((value) => { if (!cancelled) setProgress(value); }).catch(() => { if (!cancelled) setProgress(null); });
    return () => { cancelled = true; };
  }, [eventVersion]);
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
  return <section className="daily-page">
    <h1>Daily standup</h1>
    {progress ? <section className="progression" aria-labelledby="progression-title">
      <div className="progression-heading"><h2 id="progression-title">Your progress</h2><strong>Level {progress.level}</strong></div>
      <label htmlFor="level-progress">{progress.levelXp} / {progress.nextLevelXp} XP to level {progress.level + 1}</label>
      <progress id="level-progress" value={progress.levelXp} max={progress.nextLevelXp} />
      <p className="muted">{progress.xp} total XP · Create a task: 10 XP · Handle an inbox item: 20 XP</p>
      <h3>Badges</h3>
      <ul className="progression-badges">{([['Tasks created', progress.tasks], ['Inbox handled', progress.inbox]] as const).flatMap(([name, count]) => [1, 10, 50].map((threshold) => <li key={`${name}-${threshold}`} className={count >= threshold ? 'earned' : ''}><strong>{name} · {threshold}</strong><span>{count >= threshold ? 'Earned' : `${count} / ${threshold}`}</span></li>))}</ul>
    </section> : null}
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
  </section>;
}
