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

export type SnoozePreset = "1h" | "4h" | "tomorrow";

export const SNOOZE_PRESETS: readonly { preset: SnoozePreset; label: string }[] = [
  { preset: "1h", label: "1h" },
  { preset: "4h", label: "4h" },
  { preset: "tomorrow", label: "Tomorrow" },
];

/** Compute the snooze-until timestamp for a preset. */
export function snoozeUntil(preset: SnoozePreset): number {
  if (preset === "1h") return Date.now() + 3_600_000;
  if (preset === "4h") return Date.now() + 4 * 3_600_000;
  const target = new Date();
  target.setHours(9, 0, 0, 0);
  target.setDate(target.getDate() + 1);
  return target.getTime();
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PR_URL_RE = /https?:\/\/\S+?\/(?:pull|merge_requests)\/\d+/;

/** The PR/MR link for an inbox item: the task's known PR first, else the
 *  first PR/MR URL in the item body (done reports carry "PR: <url>"). */
export function itemPrUrl(body: string, taskPrUrl: string | null | undefined): string | null {
  if (taskPrUrl) return taskPrUrl;
  return body.match(PR_URL_RE)?.[0] ?? null;
}

/** "PR #42" for GitHub, "MR !42" for GitLab, "PR" when the number is unknown. */
export function prLabel(url: string): string {
  const gl = url.match(/merge_requests\/(\d+)/);
  if (gl) return `MR !${gl[1]}`;
  const gh = url.match(/\/pull\/(\d+)/);
  return gh ? `PR #${gh[1]}` : "PR";
}

/** GitHub pull request or GitLab merge request URL (mirrors the server check). */
export function isPrUrl(url: string): boolean {
  return /^https?:\/\/[^\s/]+\/[^\s]+?(?:\/pull\/|\/-\/merge_requests\/)\d+\/?$/.test(url.trim());
}
