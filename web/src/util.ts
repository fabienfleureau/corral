// Small formatting helpers shared across pages.

export function timeAgo(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(ms).toLocaleDateString();
}

export function formatTs(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** Compute the snooze-until timestamp for a preset. */
export function snoozeUntil(preset: "1h" | "tomorrow" | "nextweek"): number {
  if (preset === "1h") return Date.now() + 3_600_000;
  const target = new Date();
  target.setHours(9, 0, 0, 0);
  target.setDate(target.getDate() + (preset === "tomorrow" ? 1 : 7));
  return target.getTime();
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
