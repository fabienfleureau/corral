// Current diff sizes of unique PRs linked to Corral tasks.
import { mapLimit, runAsync } from "./exec.ts";
import type { Task } from "./types.ts";

export interface PrAdditions {
  additions: number;
  available: number;
  total: number;
}

export async function fetchPrAdditions(url: string): Promise<number | null> {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com" && /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(parsed.pathname)) {
      const data = JSON.parse(await runAsync("gh", ["pr", "view", url, "--json", "additions"]));
      return Number.isSafeInteger(data.additions) && data.additions >= 0 ? data.additions : null;
    }
    const match = parsed.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
    if (!match || !["http:", "https:"].includes(parsed.protocol)) return null;
    const project = encodeURIComponent(match[1]);
    const data = JSON.parse(await runAsync("glab", ["api", `projects/${project}/merge_requests/${match[2]}/changes`, "--hostname", parsed.host]));
    if (!Array.isArray(data.changes) || data.overflow === true || data.changes.some((c: { diff?: unknown }) => typeof c.diff !== "string")) return null;
    return data.changes.reduce((sum: number, c: { diff: string }) => sum + c.diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length, 0);
  } catch {
    return null;
  }
}

export async function collectPrAdditions(tasks: Pick<Task, "pr_url">[], fetcher = fetchPrAdditions): Promise<PrAdditions> {
  const urls = [...new Set(tasks.flatMap((t) => t.pr_url ? [t.pr_url] : []))];
  const counts = await mapLimit(urls, 4, async (url) => {
    try { return await fetcher(url); } catch { return null; }
  });
  return { additions: counts.reduce<number>((sum, n) => sum + (n ?? 0), 0), available: counts.filter((n) => n !== null).length, total: urls.length };
}

export class PrAdditionsCache {
  private value: PrAdditions | null = null;
  private updated = 0;
  private pending: Promise<void> | null = null;
  private key = "";

  get(tasks: Pick<Task, "pr_url">[], force = false): { data: PrAdditions | null; scanning: boolean } {
    const key = JSON.stringify([...new Set(tasks.flatMap((t) => t.pr_url ? [t.pr_url] : []))].sort());
    if (!this.pending && (force || key !== this.key || Date.now() - this.updated > 300_000)) {
      this.pending = collectPrAdditions(tasks).then((data) => { this.value = data; this.updated = Date.now(); this.key = key; }).finally(() => { this.pending = null; });
    }
    return { data: this.value, scanning: this.pending !== null };
  }
}
