import { useEffect, useState } from "react";
import { api } from "../api";
import { thresholds } from "../progress-celebration";

type Progress = Awaited<ReturnType<typeof api.progression>>;

function BadgeArt({ type, tier }: { type: "tasks" | "inbox"; tier: number }) {
  return <svg className="badge-art" viewBox="0 0 80 88" aria-hidden="true">
    <path fill="#9d6330" d="M24 55 20 85l20-10 20 10-4-30" />
    <circle cx="40" cy="36" r="33" fill={tier === 1 ? "#c77942" : tier === 10 ? "#819bac" : "#d5a637"} />
    <circle cx="40" cy="36" r="25" fill="#fff7df" stroke="#fff" strokeWidth="2" />
    {type === "tasks" ? <path d="m27 36 8 8 18-19" fill="none" stroke="#75532c" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /> : <path d="M25 28h30v22H25z M25 40h8l3 4h8l3-4h8" fill="none" stroke="#75532c" strokeWidth="4" strokeLinejoin="round" />}
  </svg>;
}

export function ProgressPage({ eventVersion }: { eventVersion: number }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.progression().then(value => { if (!cancelled) { setProgress(value); setError(false); } }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [eventVersion]);
  return <section className="progression">
    <h1>Your progress</h1>
    {error ? <p className="inline-error" role="alert">Could not load your progress.</p> : null}
    {!progress && !error ? <p>Loading progress…</p> : null}
    {progress ? <>
      <div className="progression-heading"><h2>Level {progress.level}</h2><strong>{progress.xp} total XP</strong></div>
      <label htmlFor="level-progress">{progress.levelXp} / {progress.nextLevelXp} XP to level {progress.level + 1}</label>
      <progress id="level-progress" value={progress.levelXp} max={progress.nextLevelXp} />
      <p className="muted">Create a task: 10 XP · Handle an inbox item: 20 XP</p>
      <h2>Badges</h2>
      <ul className="progression-badges">{([['tasks', 'Tasks created', progress.tasks], ['inbox', 'Inbox handled', progress.inbox]] as const).flatMap(([type, name, count]) => thresholds.map(threshold => <li key={`${type}-${threshold}`} className={count >= threshold ? 'earned' : ''}>
        <BadgeArt type={type} tier={threshold} /><strong>{name} · {threshold}</strong><span>{count >= threshold ? 'Earned' : `${count} / ${threshold}`}</span>
      </li>))}</ul>
    </> : null}
  </section>;
}
