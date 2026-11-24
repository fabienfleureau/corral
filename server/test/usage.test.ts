// Usage page: log parsing, dedupe, pricing, quota and task attribution.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PRICES,
  GoQuotaCache,
  UsageScanner,
  attachQuotaPredictions,
  buildReport,
  claudeQuota,
  codexQuota,
  inferWindowMs,
  monthWindowMs,
  opencodeGoQuota,
  parseClaudeLine,
  parseCodexLines,
  predictQuotaWindow,
  priceFor,
  recordCost,
  type AgentQuota,
  type QuotaWindow,
  type UsageRecord,
} from "../usage.ts";
import type { Task } from "../types.ts";

function claudeLine(over: { id?: string; req?: string; model?: string; cwd?: string; ts?: string; usage?: object } = {}): string {
  return JSON.stringify({
    type: "assistant",
    requestId: over.req ?? "req_1",
    cwd: over.cwd ?? "/w/a",
    timestamp: over.ts ?? "2026-11-03T10:00:00Z",
    message: {
      id: over.id ?? "msg_1",
      model: over.model ?? "claude-opus-5-5",
      usage: over.usage ?? {
        input_tokens: 10,
        output_tokens: 1000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 2000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 },
      },
    },
  });
}

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
  return { agent: "claude", key: "", ts: Date.parse("2026-11-03T10:00:00Z"), model: "claude-opus-5-5", cwd: "", input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...over };
}

test("parseClaudeLine: reads usage, splits cache writes, skips synthetic", () => {
  const r = parseClaudeLine(claudeLine());
  assert.ok(r);
  assert.equal(r.key, "msg_1:req_1");
  assert.equal(r.cacheWrite1h, 2000);
  assert.equal(r.cacheWrite5m, 0);
  assert.equal(parseClaudeLine(claudeLine({ model: "<synthetic>" })), null);
  assert.equal(parseClaudeLine('{"type":"user"}'), null);
  // No breakdown: all cache creation counts as 5m.
  const legacy = parseClaudeLine(claudeLine({ usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 50 } }));
  assert.equal(legacy?.cacheWrite5m, 50);
});

test("pricing: exact beats prefix, cache defaults derive from input", () => {
  assert.equal(priceFor("claude-opus-5-5", DEFAULT_PRICES)?.input, 4);
  assert.equal(priceFor("claude-sonnet-5-5", DEFAULT_PRICES)?.input, 2);
  assert.equal(priceFor("gpt-unknown", DEFAULT_PRICES), null);
  // opus 5.5: 10*4 + 1000*20 + 100k*0.2 + 2000*(4*2) = 40 + 20000 + 20000 + 16000
  const cost = recordCost(parseClaudeLine(claudeLine())!, DEFAULT_PRICES);
  assert.ok(cost !== null && Math.abs(cost - 56_040 / 1e6) < 1e-12);
  assert.equal(recordCost(rec({ model: "gpt-unknown", agent: "codex" }), DEFAULT_PRICES), null);
});

test("shared prices estimate MiMo and free Beam usage", () => {
  assert.equal(recordCost(rec({ model: "mimo-v2.6-pro", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }), DEFAULT_PRICES), 1.3086);
  assert.equal(recordCost(rec({ model: "beam-free", input: 1_000_000, output: 1_000_000 }), DEFAULT_PRICES), 0);
});

test("free models count as priced, not as unpriced calls", () => {
  const report = buildReport({
    records: [rec({ agent: "opencode-go", model: "hy4-flash-free", input: 1_000_000, output: 1_000_000 })],
    tasks: [],
    prices: DEFAULT_PRICES,
    range: "all",
    scanning: false,
  });
  assert.equal(report.totals.unpriced_calls, 0);
  assert.equal(report.totals.cost_usd, 0);
  assert.equal(report.by_model[0].priced, true);
});

test("shared Tencent price estimates Hy4 at list price", () => {
  const cost = recordCost(rec({ agent: "opencode-go", model: "hy4", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }), DEFAULT_PRICES);
  assert.ok(cost !== null && Math.abs(cost - 3.377) < 1e-9);
});

test("shared OpenAI prices include discounted cached input", () => {
  for (const [model, expected] of [["gpt-6.1-terra", 6.05], ["gpt-6.1-sol", 12.1], ["gpt-6.2-sol", 12.1], ["gpt-6-luna", 0.61]] as const) {
    assert.equal(recordCost(rec({ model, agent: "codex", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }), DEFAULT_PRICES), expected);
  }
});

test("parseCodexLines: deltas of running totals, cached is a subset of input", () => {
  const tc = (ts: string, input: number, cached: number, output: number, rl?: object) =>
    JSON.stringify({
      timestamp: ts,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } }, rate_limits: rl ?? null },
    });
  const lines = [
    JSON.stringify({ timestamp: "2026-11-03T10:00:00Z", type: "session_meta", payload: { cwd: "/w/b" } }),
    JSON.stringify({ timestamp: "2026-11-03T10:00:01Z", type: "turn_context", payload: { model: "gpt-6.1-terra" } }),
    tc("2026-11-03T10:00:02Z", 1000, 400, 50),
    tc("2026-11-03T10:00:03Z", 1000, 400, 50), // repeated event: no new usage
    tc("2026-11-03T10:00:04Z", 3000, 2400, 80, { plan_type: "team", primary: { used_percent: 5, window_minutes: 10080, resets_at: 1793782524 } }),
  ];
  const { records, rateLimits } = parseCodexLines(lines, "f");
  assert.equal(records.length, 2);
  assert.deepEqual([records[0].input, records[0].cacheRead, records[0].output], [600, 400, 50]);
  assert.deepEqual([records[1].input, records[1].cacheRead, records[1].output], [0, 2000, 30]);
  assert.equal(records[1].model, "gpt-6.1-terra");
  assert.equal(records[1].cwd, "/w/b");
  assert.equal(rateLimits?.plan, "team");
  const q = codexQuota(rateLimits, Date.parse("2026-11-03T12:00:00Z"));
  assert.equal(q.windows[0].label, "Weekly");
  assert.equal(q.windows[0].resets_ms, 1793782524000);
  assert.equal(q.stale, false);
});

test("UsageScanner: dedupes Claude messages repeated across lines and files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-usage-"));
  try {
    const claude = join(dir, "claude", "proj", "sub");
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, "a.jsonl"), [claudeLine(), claudeLine(), claudeLine({ id: "msg_2" })].join("\n") + "\n");
    writeFileSync(join(dir, "claude", "proj", "b.jsonl"), claudeLine() + "\n"); // resumed copy
    const s = new UsageScanner({ claudeDir: join(dir, "claude"), codexDir: join(dir, "nope"), claudeQuotaDir: dir });
    await s.refresh();
    assert.equal(s.records().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claudeQuota: freshest snapshot, stale once a reset has passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-quota-"));
  try {
    writeFileSync(
      join(dir, "usage-x.json"),
      JSON.stringify({ sessionUsage: 39, sessionResetAt: "2026-11-04T02:09:59Z", weeklyUsage: 20, weeklyResetAt: "2026-11-09T01:59:59Z" }),
    );
    const fresh = claudeQuota(dir, Date.parse("2026-11-04T01:00:00Z"));
    assert.deepEqual(fresh.windows.map((w) => w.used_percent), [39, 20]);
    assert.equal(fresh.stale, false);
    assert.equal(claudeQuota(dir, Date.parse("2026-11-05T00:00:00Z")).stale, true);
    assert.equal(claudeQuota(join(dir, "missing")).windows.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildReport: range filter, task attribution and efficiency", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const task = (id: string, worktree: string, status: Task["status"]) => ({ id, title: id, prompt: "", worktree_path: worktree, status }) as Task;
  const tasks = [task("t1", "/wt/one", "done"), task("t2", "/wt/two", "dispatched")];
  const r = buildReport({
    records: [
      rec({ cwd: "/wt/one", output: 1_000_000, ts: now - 3_600_000 }), // $20
      rec({ cwd: "/wt/one/sub", output: 500_000, ts: now - 3_600_000 }), // $10, same task
      rec({ cwd: "/wt/two", output: 250_000, ts: now - 7_200_000 }), // $5
      rec({ cwd: "/home", output: 100_000, ts: now - 7_200_000 }), // $2, no task
      rec({ cwd: "/wt/one", output: 1_000_000, ts: now - 10 * 86_400_000 }), // out of 7d
      rec({ agent: "codex", model: "gpt-x", output: 10, ts: now - 1000 }), // unpriced
    ],
    tasks,
    prices: DEFAULT_PRICES,
    range: "7d",
    scanning: false,
    now,
  });
  assert.equal(r.totals.calls, 5);
  assert.equal(r.totals.unpriced_calls, 1);
  assert.ok(Math.abs(r.totals.cost_usd - 37) < 1e-9);
  assert.equal(r.efficiency.tasks_with_spend, 2);
  assert.equal(r.efficiency.tasks_done, 1);
  assert.ok(Math.abs(r.efficiency.attributed_usd - 35) < 1e-9);
  assert.ok(Math.abs(r.efficiency.unattributed_usd - 2) < 1e-9);
  assert.ok(Math.abs((r.efficiency.usd_per_done_task ?? 0) - 30) < 1e-9);
  assert.ok(Math.abs((r.efficiency.tasks_per_usd ?? 0) - 1 / 35) < 1e-12);
  assert.equal(r.efficiency.top_tasks[0].id, "t1");
  assert.equal(r.bucket, "day");
  assert.ok(r.timeline.length >= 7);
});

test("buildReport: timeline keeps per-model cost and tokens in each bucket", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const r = buildReport({
    records: [
      rec({ ts: today.getTime() + 3_600_000, output: 1_000_000 }), // opus: $20
      rec({ ts: today.getTime() + 3_600_000, model: "claude-sonnet-5-5", output: 500_000 }), // $5
      rec({ ts: yesterday.getTime() + 3_600_000, output: 250_000 }), // $5
      rec({ ts: yesterday.getTime() + 3_600_000, agent: "codex", model: "gpt-unknown", input: 100 }), // unpriced
    ],
    tasks: [],
    prices: DEFAULT_PRICES,
    range: "7d",
    scanning: false,
    now,
  });
  assert.deepEqual(r.timeline.find((b) => b.start_ms === today.getTime())?.models, [
    { agent: "claude", model: "claude-opus-5-5", cost_usd: 20, tokens: 1_000_000 },
    { agent: "claude", model: "claude-sonnet-5-5", cost_usd: 5, tokens: 500_000 },
  ]);
  assert.deepEqual(r.timeline.find((b) => b.start_ms === yesterday.getTime())?.models, [
    { agent: "claude", model: "claude-opus-5-5", cost_usd: 5, tokens: 250_000 },
    { agent: "codex", model: "gpt-unknown", cost_usd: 0, tokens: 100 },
  ]);
  assert.ok(r.timeline.every((b) => Array.isArray(b.models)));
  assert.ok(r.timeline.some((b) => b.models.length === 0)); // filled empty buckets
});

test("OpenCode Go quota reads subscription windows and handles failures", async () => {
  const { opencodeGoQuota } = await import("../usage.ts");
  const dir = mkdtempSync(join(tmpdir(), "corral-go-"));
  try {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "test-key" } }));
    const fetcher: typeof fetch = async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
      return new Response(JSON.stringify({ usage: { rolling: { status: "ok", percent: 12.5, resetsAt: "2026-11-06T00:00:00Z" }, weekly: { status: "ok", percent: 30, resetsAt: "2026-11-10T00:00:00Z" }, monthly: { status: "ok", percent: 40, resetsAt: "2026-12-01T00:00:00Z" } } }));
    };
    const q = await opencodeGoQuota(dir, fetcher, Date.parse("2026-11-05T00:00:00Z"));
    assert.deepEqual(q.windows.map(w => [w.label, w.used_percent]), [["5-hour session", 12.5], ["Weekly", 30], ["Monthly", 40]]);
    assert.equal(q.stale, false);
    assert.equal((await opencodeGoQuota(dir, async () => new Response("", { status: 401 }))).windows.length, 0);
    assert.equal((await opencodeGoQuota(join(dir, "missing"), fetcher)).windows.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("UsageScanner reads OpenCode Go messages and includes them in the timeline", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "corral-go-usage-"));
  try {
    const db = new DatabaseSync(join(dir, "opencode.db"));
    db.exec("CREATE TABLE session_v2 (id TEXT, directory TEXT); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)");
    db.prepare("INSERT INTO session_v2 VALUES (?, ?)").run("s", "/wt/go");
    const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)");
    const now = Date.now();
    insert.run("m1", "s", "assistant", now, JSON.stringify({ model: { providerID: "opencode-go", id: "mimo" }, tokens: { input: 100, output: 20, cache: { read: 30, write: 4 } } }));
    insert.run("m2", "s", "assistant", now, JSON.stringify({ model: { providerID: "other", id: "mimo" }, tokens: { input: 500 } }));
    db.close();
    const scanner = new UsageScanner({ claudeDir: dir + "/none", codexDir: dir + "/none", claudeQuotaDir: dir, opencodeDir: dir });
    await scanner.refresh();
    const report = buildReport({ records: scanner.records(), tasks: [], prices: { mimo: { input: 1, output: 2 } }, range: "24h", scanning: false, now });
    assert.equal(report.by_model[0].agent, "opencode-go");
    assert.equal(report.totals.input, 100);
    assert.equal(report.totals.cache_read, 30);
    assert.equal(report.totals.cache_write, 4);
    assert.equal(report.timeline.reduce((sum, b) => sum + b.opencode_go_tokens, 0), 154);
    assert.ok(report.timeline.some(b => b.opencode_go > 0));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("PR additions deduplicate links and report unavailable counts", async () => {
  const { collectPrAdditions } = await import("../usage-pr.ts");
  const result = await collectPrAdditions([
    { pr_url: "https://github.com/a/b/pull/1" },
    { pr_url: "https://github.com/a/b/pull/1" },
    { pr_url: "https://example.com/a/-/merge_requests/2" },
    { pr_url: null },
  ], async (url) => url.includes("github") ? 42 : null);
  assert.deepEqual({ additions: result.additions, available: result.available, total: result.total }, { additions: 42, available: 1, total: 2 });
});

test("PR additions group unique links by project, configured model and task", async () => {
  const { collectPrAdditions } = await import("../usage-pr.ts");
  const tasks = [
    { id: "1", title: "First", prompt: "", repo_path: "/work/a", model: "gpt", pr_url: "https://github.com/a/b/pull/1" },
    { id: "2", title: "Second", prompt: "", repo_path: "/work/a", model: null, pr_url: "https://github.com/a/b/pull/1" },
    { id: "3", title: "Third", prompt: "", repo_path: "/work/b", model: "gpt", pr_url: "https://github.com/a/b/pull/2" },
  ];
  const result = await collectPrAdditions(tasks, async (url) => url.endsWith("1") ? 10 : null);
  assert.deepEqual(result.by_project, [
    { key: "/work/a", additions: 10, available: 1, total: 1 },
    { key: "/work/b", additions: 0, available: 0, total: 1 },
  ]);
  assert.deepEqual(result.by_model, [
    { key: "", additions: 10, available: 1, total: 1 },
    { key: "gpt", additions: 10, available: 1, total: 2 },
  ]);
  assert.equal(result.by_task.length, 3);
  assert.equal(result.by_task[1].additions, 10);
});

const quotaSnapshot: AgentQuota = { agent: "opencode-go", source: "OpenCode Go", as_of_ms: 1, stale: false, plan: null, windows: [], note: null };

test("GoQuotaCache answers a burst of polls with one upstream call", async () => {
  let calls = 0;
  let now = 0;
  const cache = new GoQuotaCache({ clock: () => now, fetchQuota: async () => { calls++; return quotaSnapshot; } });
  const burst = await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(calls, 1);
  assert.deepEqual(burst.map((q) => q.as_of_ms), [1, 1, 1]);
  // Still fresh: served from the cache.
  await cache.get();
  assert.equal(calls, 1);
  // Past the TTL: refreshed.
  now += 61_000;
  await cache.get();
  assert.equal(calls, 2);
});

test("GoQuotaCache retries a failed upstream after a short pause", async () => {
  let calls = 0;
  let now = 0;
  const cache = new GoQuotaCache({ clock: () => now, fetchQuota: async () => { calls++; throw new Error("upstream down"); } });
  const first = await cache.get();
  assert.match(first.note ?? "", /Could not reach/);
  await cache.get();
  assert.equal(calls, 1, "the failure is remembered briefly instead of hammering");
  now += 11_000;
  await cache.get();
  assert.equal(calls, 2);
});

test("GoQuotaCache hands back a note instead of waiting on a slow upstream", async () => {
  const cache = new GoQuotaCache({ clock: () => 0, fetchQuota: () => new Promise<AgentQuota>(() => undefined) });
  const value = await cache.get();
  assert.match(value.note ?? "", /slow/);
});

test("opencodeGoQuota skips a malformed response instead of throwing", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "corral-quota-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { key: "k" } }));
    const quota = await opencodeGoQuota(dir, async () => new Response(JSON.stringify({ usage: {} }), { status: 200 }));
    assert.equal(quota.windows.length, 0);
    assert.match(quota.note ?? "", /invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("monthWindowMs and inferWindowMs handle calendar months, leap years, and labels", () => {
  const DAY = 86_400_000;
  // March 31 -> Feb 28 (non-leap 2026) = 31 days; March 31 -> Feb 29 (leap 2024) = 31 days? Wait: Feb has 28 days in 2026, so Feb 28..Mar 31 is 31 days.
  // Check Feb 28 -> Jan 28 (31 days) and Mar 31 -> Feb 28 (2026, 31 days) vs Mar 28 -> Feb 28 (2026, 28 days; 2024, 29 days).
  assert.equal(monthWindowMs(Date.UTC(2026, 2, 28, 12, 0)), 28 * DAY);
  assert.equal(monthWindowMs(Date.UTC(2024, 2, 28, 12, 0)), 29 * DAY);
  assert.equal(monthWindowMs(Date.UTC(2026, 2, 31, 0, 0)), 31 * DAY);
  assert.equal(monthWindowMs(Date.UTC(2026, 0, 15, 6, 0)), 31 * DAY);

  const reset = Date.UTC(2026, 11, 1, 0, 0);
  assert.equal(inferWindowMs("Monthly", reset), 30 * DAY);
  assert.equal(inferWindowMs("Weekly (all models)", reset), 7 * DAY);
  assert.equal(inferWindowMs("2-week", reset), 14 * DAY);
  assert.equal(inferWindowMs("5-hour session", reset), 5 * 3_600_000);
  assert.equal(inferWindowMs("Gemini · Five Hour", reset), 5 * 3_600_000);
  assert.equal(inferWindowMs("30d limit", reset), 30 * DAY);
  assert.equal(inferWindowMs("Daily", reset), DAY);
  assert.equal(inferWindowMs("30-minute", reset), 30 * 60_000);
  assert.equal(inferWindowMs("Unknown bucket", reset), null);
});

test("predictQuotaWindow skips short windows, stale resets, and noisy early starts", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 24, 12, 0);
  const baseWin = (over: Partial<QuotaWindow>): QuotaWindow => ({
    label: "Weekly",
    used_percent: 40,
    resets_ms: now + 3 * DAY,
    window_ms: 7 * DAY,
    ...over,
  });

  // Short 5h window is not a higher (week/month) quota.
  assert.equal(
    predictQuotaWindow({
      agent: "claude",
      window: baseWin({ label: "5-hour session", window_ms: 5 * 3_600_000, resets_ms: now + 3 * 3_600_000 }),
      records: [],
      prices: DEFAULT_PRICES,
      now,
    }),
    null,
  );
  // Stale reset passed.
  assert.equal(
    predictQuotaWindow({
      agent: "claude",
      window: baseWin({ resets_ms: now - 1000 }),
      records: [],
      prices: DEFAULT_PRICES,
      now,
    }),
    null,
  );
  // Very early in window with low usage (< 5.9h elapsed and < 20% used).
  assert.equal(
    predictQuotaWindow({
      agent: "claude",
      window: baseWin({ used_percent: 5, resets_ms: now + 7 * DAY - 2 * 3_600_000 }),
      records: [],
      prices: DEFAULT_PRICES,
      now,
    }),
    null,
  );
  // Early spike (>= 20% used) still predicts.
  const spike = predictQuotaWindow({
    agent: "claude",
    window: baseWin({ used_percent: 30, resets_ms: now + 7 * DAY - 2 * 3_600_000 }),
    records: [],
    prices: DEFAULT_PRICES,
    now,
  });
  assert.equal(spike?.status, "will_hit");
  assert.equal(spike?.will_hit, true);

  // 100% exhausted -> hit.
  const hit = predictQuotaWindow({
    agent: "opencode-go",
    window: baseWin({ label: "Monthly", used_percent: 100, window_ms: 30 * DAY, resets_ms: now + 10 * DAY }),
    records: [],
    prices: DEFAULT_PRICES,
    now,
  });
  assert.deepEqual(hit, {
    will_hit: true,
    status: "hit",
    projected_percent: 100,
    hits_in_ms: 0,
    hits_at_ms: now,
    rate_per_day: 5,
    basis: "pace",
  });

  // 0% used -> safe.
  const zero = predictQuotaWindow({
    agent: "claude",
    window: baseWin({ used_percent: 0 }),
    records: [],
    prices: DEFAULT_PRICES,
    now,
  });
  assert.equal(zero?.status, "safe");
  assert.equal(zero?.projected_percent, 0);
  assert.equal(zero?.will_hit, false);
});

test("predictQuotaWindow computes pace fallback and curve-weighted forecasts", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 24, 12, 0);
  const resetsMs = now + 3 * DAY; // 4 days elapsed, 3 days left in 7d window

  // Pace fallback (no records): 30% in 4d -> 7.5%/d -> 52.5% projected -> safe.
  const safe = predictQuotaWindow({
    agent: "codex",
    window: { label: "Weekly", used_percent: 30, resets_ms: resetsMs, window_ms: 7 * DAY },
    records: [],
    prices: DEFAULT_PRICES,
    now,
  });
  assert.equal(safe?.basis, "pace");
  assert.equal(safe?.status, "safe");
  assert.equal(safe?.projected_percent, 52.5);

  // Pace close: 52% in 4d -> 13%/d -> 91% projected -> close.
  const close = predictQuotaWindow({
    agent: "codex",
    window: { label: "Weekly", used_percent: 52, resets_ms: resetsMs, window_ms: 7 * DAY },
    records: [],
    prices: DEFAULT_PRICES,
    now,
  });
  assert.equal(close?.status, "close");
  assert.equal(close?.will_hit, false);
  assert.equal(close?.projected_percent, 91);

  // Ramp-up curve: 50% in 4d (avg 12.5%/d -> pace would say 87.5% safe/close),
  // but heavy recent usage makes EWMA curve predict will_hit.
  const rampRecords: UsageRecord[] = [
    rec({ agent: "codex", model: "gpt-6.1-sol", ts: now - 3.5 * DAY, output: 100_000 }),
    rec({ agent: "codex", model: "gpt-6.1-sol", ts: now - 0.5 * DAY, output: 1_000_000 }),
    rec({ agent: "codex", model: "gpt-6.1-sol", ts: now - 0.1 * DAY, output: 1_000_000 }),
  ];
  const ramp = predictQuotaWindow({
    agent: "codex",
    window: { label: "Weekly", used_percent: 50, resets_ms: resetsMs, window_ms: 7 * DAY },
    records: rampRecords,
    prices: DEFAULT_PRICES,
    now,
  });
  assert.equal(ramp?.basis, "curve");
  assert.equal(ramp?.status, "will_hit");
  assert.equal(ramp?.will_hit, true);
  assert.ok(ramp && ramp.projected_percent > 100);
  assert.ok(ramp && ramp.hits_in_ms !== null && ramp.hits_in_ms > 0 && ramp.hits_in_ms < 3 * DAY);

  // Cool-down curve: 64% in 4d (avg 16%/d -> pace would say 112% will_hit),
  // but usage was front-loaded on day 1 and stopped -> curve predicts safe.
  const coolRecords: UsageRecord[] = [
    rec({ agent: "claude", model: "claude-opus-5-5", ts: now - 3.9 * DAY, output: 2_000_000 }),
    rec({ agent: "claude", model: "claude-opus-5-5", ts: now - 0.2 * DAY, output: 50_000 }),
  ];
  const cool = predictQuotaWindow({
    agent: "claude",
    window: { label: "Weekly Opus", used_percent: 64, resets_ms: resetsMs, window_ms: 7 * DAY },
    records: coolRecords,
    prices: DEFAULT_PRICES,
    now,
  });
  assert.equal(cool?.basis, "curve");
  assert.equal(cool?.will_hit, false);
  assert.ok(cool && cool.projected_percent < 100);

  // Model filter: Sonnet records do not skew Opus prediction; unpriced tokens still drive curve.
  const filtered = predictQuotaWindow({
    agent: "claude",
    window: { label: "Weekly Opus", used_percent: 40, resets_ms: resetsMs, window_ms: 7 * DAY },
    records: [rec({ agent: "claude", model: "claude-sonnet-5-5", ts: now - 0.1 * DAY, output: 5_000_000 })],
    prices: DEFAULT_PRICES,
    now,
  });
  assert.equal(filtered?.basis, "pace");

  // Unpriced model falls back to token weights for the curve.
  const unpriced = predictQuotaWindow({
    agent: "google",
    window: { label: "Gemini · Weekly", used_percent: 50, resets_ms: resetsMs, window_ms: 7 * DAY },
    records: [
      rec({ agent: "antigravity", model: "gemini-experimental-custom", ts: now - 3.5 * DAY, output: 1000 }),
      rec({ agent: "antigravity", model: "gemini-experimental-custom", ts: now - 0.2 * DAY, output: 100_000 }),
    ],
    prices: DEFAULT_PRICES,
    now,
  });
  assert.equal(unpriced?.basis, "curve");
  assert.equal(unpriced?.will_hit, true);

  // Monthly window works too.
  const monthly = predictQuotaWindow({
    agent: "opencode-go",
    window: { label: "Monthly", used_percent: 80, resets_ms: now + 10 * DAY, window_ms: 30 * DAY },
    records: [],
    prices: DEFAULT_PRICES,
    now,
  });
  assert.equal(monthly?.will_hit, true);
  assert.equal(monthly?.status, "will_hit");
  assert.equal(monthly?.projected_percent, 120);
});

test("attachQuotaPredictions clones snapshots without mutating cached inputs", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 24, 12, 0);
  const original: AgentQuota = {
    agent: "opencode-go",
    source: "OpenCode Go",
    as_of_ms: now,
    stale: false,
    plan: null,
    windows: [
      { label: "5-hour session", used_percent: 40, resets_ms: now + 2 * 3_600_000, window_ms: 5 * 3_600_000 },
      { label: "Weekly", used_percent: 40, resets_ms: now + 3 * DAY, window_ms: 7 * DAY },
    ],
    note: null,
  };
  const enriched = attachQuotaPredictions([original], [], DEFAULT_PRICES, now);
  assert.equal(original.windows[1].prediction, undefined);
  assert.equal(enriched[0].windows[0].prediction, null);
  assert.equal(enriched[0].windows[1].prediction?.status, "safe");
});
