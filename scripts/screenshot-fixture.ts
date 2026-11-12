import { Db } from "../server/db.ts";
import type { Favorite } from "../server/favorites.ts";
import { prItemBody, type PrInfo } from "../server/pr.ts";
import type { Item, Task } from "../server/types.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** One favorite per context, plus one more professional, to show the task form filter. */
export const screenshotFavorites: Favorite[] = [
  { name: "Careful review", harness: "claude", agent: "", model: "opus", reasoning: "high", context: "professional", review: "cubic" },
  { name: "Quick fix", harness: "codex", agent: "", model: "gpt-6.1-sol", reasoning: "low", context: "professional", review: "" },
  { name: "Bulk Go work", harness: "opencode", agent: "", model: "opencode-go/kimi-k3.1-pro", reasoning: "", context: "professional", review: "" },
  { name: "Side project", harness: "opencode", agent: "", model: "opencode-go/claude-haiku-5-5", reasoning: "high", context: "personal", review: "" },
];

export function seedScreenshotData(db: Db): void {
  const rows: Pick<Task, "id" | "title" | "status" | "target" | "model" | "reasoning" | "review">[] = [
    { id: "sample-open", title: "Improve search results", status: "open", target: "codex", model: "gpt-5.4", reasoning: "high" },
    { id: "sample-running", title: "Add keyboard navigation", status: "dispatched", target: "claude", model: null, reasoning: null, review: "cubic review --base main --json" },
    { id: "sample-done", title: "Update project documentation", status: "done", target: "codex", model: null, reasoning: null },
  ];
  const now = Date.UTC(2025, 0, 15, 12);
  rows.forEach((row, index) => db.insertTask({
    ...row, prompt: row.title, repo_path: "/sample/example-project", target_state: "confirmed",
    base_branch: "main", branch: null, worktree_path: null, assignee: null, jira_key: null,
    jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null, terminal_address: null,
    exit_code: null, created_ms: now - index * 60000, updated_ms: now - index * 60000,
  }));
  db.insertRepo({ id: "sample-work", name: "example-project", path: "/sample/example-project", jira_prefix: "EX", context: null, source: "manual", created_ms: now });
  db.insertRepo({ id: "sample-home", name: "side-project", path: "/sample/side-project", jira_prefix: null, context: "personal", source: "manual", created_ms: now });
  seedInboxItems(db, now);
  seedBenchmarks(db);
}

/** Open inbox items: a ready PR, a PR still needing work, and a question. */
export function seedInboxItems(db: Db, now = Date.UTC(2025, 0, 15, 12)): void {
  const pr = (overrides: Partial<PrInfo>): PrInfo => ({
    url: "https://github.com/example/project/pull/42",
    title: "feat(search): rank results by recency",
    state: "OPEN",
    number: 42,
    description: "## Why\n\nRecent results are buried under old but heavily linked ones.\n\n## What\n\nRank by recency and show why a result matched.",
    additions: 142,
    deletions: 38,
    changed_files: 6,
    mergeable: "MERGEABLE",
    base_ref: "main",
    review_decision: null,
    human_approvals: null,
    checks: { total: 3, failed: 0, pending: false },
    threads: [],
    ...overrides,
  });
  const items: Item[] = [
    {
      id: "sample-pr-ready",
      kind: "pr",
      status: "open",
      title: "PR ready for review: feat(search): rank results by recency",
      summary: "ready for review",
      body: prItemBody(pr({})),
      context: "",
      options: null,
      ready: 1,
      source_ref: null,
      task_id: null,
      structured: 1,
      created_ms: now - 20 * 60_000,
      updated_ms: now - 20 * 60_000,
      resolved_ms: null,
      snooze_until_ms: null,
    },
    {
      id: "sample-pr-work",
      kind: "pr",
      status: "open",
      title: "PR needs work: fix(auth): refresh expired session tokens",
      summary: "1 unresolved review comment, 1 failing check",
      body: prItemBody(pr({
        url: "https://gitlab.com/example/platform/-/merge_requests/29",
        title: "fix(auth): refresh expired session tokens",
        number: 29,
        description: "## Why\n\nLong-lived tabs lost their session after the access token expired.\n\n## What\n\nRefresh the token before the request and retry once on 401.",
        additions: 64,
        deletions: 12,
        changed_files: 3,
        checks: { total: 3, failed: 1, pending: false },
        threads: [{ id: "note-1", author: "reviewer", body: "Please cover the concurrent refresh case." }],
      })),
      context: "",
      options: null,
      ready: 0,
      source_ref: null,
      task_id: null,
      structured: 1,
      created_ms: now - 3 * 60 * 60_000,
      updated_ms: now - 3 * 60 * 60_000,
      resolved_ms: null,
      snooze_until_ms: null,
    },
    {
      id: "sample-question",
      kind: "question",
      status: "open",
      title: "Which page size should the search endpoint default to?",
      summary: "",
      body: "Both clients paginate, but they disagree on the default.\n\n- `20` keeps the first response small.\n- `50` halves the number of round trips for bulk imports.\n\nThe endpoint is not public yet, so either default is cheap to change later.",
      context: "",
      options: JSON.stringify(["20", "50", "none"]),
      ready: 1,
      source_ref: null,
      task_id: null,
      structured: 1,
      created_ms: now - 26 * 60 * 60_000,
      updated_ms: now - 26 * 60 * 60_000,
      resolved_ms: null,
      snooze_until_ms: null,
    },
  ];
  for (const item of items) db.insertItem(item);
}

/** Published results for the benchmark matrix: matched, versioned and orphaned models. */
export function seedBenchmarks(db: Db): void {
  const results = [
    ["verified/sonar-opus", "SWE-bench Verified", "Sonar Foundation Agent", "Opus 5.5", null, 79.2, "2026-02-04"],
    ["verified/mini-opus", "SWE-bench Verified", "mini-SWE-agent", "Opus 5.5", "high", 76.8, "2026-01-28"],
    ["verified/harness-sonnet", "SWE-bench Verified", "Harness AI", "Sonnet 5.5", null, 74.8, "2026-02-01"],
    ["verified/mini-gpt", "SWE-bench Verified", "mini-SWE-agent", "GPT-6.1 Sol", "high", 72.8, "2026-01-22"],
    ["verified/flash", "SWE-bench Verified", "mini-SWE-agent", "Gemini 3.8 Flash", null, 71.4, "2026-01-19"],
    ["verified/glm", "SWE-bench Verified", "mini-SWE-agent", "GLM-5.3", "high", 68.1, "2026-01-17"],
    ["verified/old-sonnet", "SWE-bench Verified", "mini-SWE-agent", "Claude 4.5 Sonnet", null, 70.6, "2025-11-02"],
    ["lite/opus", "SWE-bench Lite", "mini-SWE-agent", "Opus 5.5", "high", 68.4, "2026-01-26"],
    ["lite/sonnet", "SWE-bench Lite", "mini-SWE-agent", "Sonnet 5.5", null, 64.9, "2026-01-21"],
    ["lite/gpt", "SWE-bench Lite", "mini-SWE-agent", "GPT-6.1 Sol", "high", 63.2, "2026-01-20"],
    ["lite/old-sonnet", "SWE-bench Lite", "Agentless", "Claude 4.5 Sonnet", null, 58.7, "2025-10-14"],
    ["multilingual/opus", "SWE-bench Multilingual", "mini-SWE-agent", "Opus 5.5", null, 72, "2026-01-30"],
    ["multilingual/sonnet", "SWE-bench Multilingual", "mini-SWE-agent", "Sonnet 5.5", null, 67.3, "2026-01-25"],
    ["terminal/opus", "Terminal-Bench 4.0", "Claude Code", "Opus 5.5", null, 64.8, "2026-02-06"],
    ["terminal/sonnet", "Terminal-Bench 4.0", "Claude Code", "Sonnet 5.5", null, 61.8, "2026-02-05"],
    ["terminal/gpt", "Terminal-Bench 4.0", "Codex", "GPT-6.1 Sol", null, 58.2, "2026-02-03"],
    ["terminal/glm", "Terminal-Bench 4.0", "mini-SWE-agent", "GLM-5.3", "high", 41.8, "2026-01-29"],
    ["terminal/flash", "Terminal-Bench 4.0", "mini-SWE-agent", "Gemini 3.8 Flash", null, 19.1, "2026-01-27"],
  ].map(([id, benchmark, agent, model, reasoning, score, date]) => ({
    id: id as string, benchmark: benchmark as string, agent: agent as string, model: model as string,
    reasoning: reasoning as string | null, score: score as number, date: date as string,
    source: `https://github.com/SWE-bench/experiments/tree/main/evaluation/fixture/${id as string}`,
  }));
  db.raw.prepare('INSERT INTO benchmark_snapshot (id, fetched_ms, results) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_ms=excluded.fetched_ms, results=excluded.results')
    .run(Date.UTC(2026, 1, 7, 9), JSON.stringify(results));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dbPath, configPath] = process.argv.slice(2);
  if (!dbPath) throw new Error("Pass a new fixture database path");
  const db = new Db(dbPath);
  try { seedScreenshotData(db); } finally { db.close(); }
  if (configPath) {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, favorites: screenshotFavorites }, null, 2) + "\n");
  }
}
