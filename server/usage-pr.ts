// Current diff sizes of unique PRs linked to Corral tasks.
import { mapLimit, runAsync } from "./exec.ts";
import { taskLabel, type Task } from "./types.ts";

type LinkedTask = Pick<Task, "pr_url"> & Partial<Pick<Task, "id" | "title" | "prompt" | "repo_path" | "model">>;
export interface PrGroup { key: string; additions: number; available: number; total: number }

export interface PrAdditions {
  additions: number;
  available: number;
  total: number;
  by_project: PrGroup[];
  by_model: PrGroup[];
  by_task: PrGroup[];
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

export async function collectPrAdditions(tasks: LinkedTask[], fetcher = fetchPrAdditions): Promise<PrAdditions> {
  const urls = [...new Set(tasks.flatMap((t) => t.pr_url ? [t.pr_url] : []))];
  const counts = await mapLimit(urls, 4, async (url) => {
    try { return await fetcher(url); } catch { return null; }
  });
  const values = new Map(urls.map((url, i) => [url, counts[i]]));
  const summarize = (links: string[]) => ({ additions: links.reduce((sum, url) => sum + (values.get(url) ?? 0), 0), available: links.filter((url) => values.get(url) != null).length, total: links.length });
  const groups = (keyFor: (task: LinkedTask) => string) => {
    const grouped = new Map<string, Set<string>>();
    for (const task of tasks) {
      if (!task.pr_url) continue;
      const key = keyFor(task);
      if (!grouped.has(key)) grouped.set(key, new Set());
      grouped.get(key)!.add(task.pr_url);
    }
    return [...grouped].map(([key, links]) => ({ key, ...summarize([...links]) })).sort((a, b) => b.additions - a.additions || a.key.localeCompare(b.key));
  };
  return { ...summarize(urls), by_project: groups((t) => t.repo_path ?? ""), by_model: groups((t) => t.model ?? ""), by_task: groups((t) => t.id ? `${t.id}\u0000${taskLabel({ title: t.title ?? "", prompt: t.prompt ?? "" })}` : "") };
}

export class PrAdditionsCache {
  private value: PrAdditions | null = null;
  private updated = 0;
  private pending: Promise<void> | null = null;
  private key = "";

  get(tasks: LinkedTask[], force = false): { data: PrAdditions | null; scanning: boolean } {
    const key = JSON.stringify(tasks.filter((t) => t.pr_url).map((t) => [t.pr_url, t.id, t.title, t.prompt, t.repo_path, t.model]).sort());
    if (!this.pending && (force || key !== this.key || Date.now() - this.updated > 300_000)) {
      this.pending = collectPrAdditions(tasks).then((data) => { this.value = data; this.updated = Date.now(); this.key = key; }).finally(() => { this.pending = null; });
    }
    return { data: this.value, scanning: this.pending !== null };
  }
}
