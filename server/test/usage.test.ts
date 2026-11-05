// Usage page: log parsing, dedupe, pricing, quota and task attribution.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PRICES,
  UsageScanner,
  buildReport,
  claudeQuota,
  codexQuota,
  parseClaudeLine,
  parseCodexLines,
  priceFor,
  recordCost,
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
  assert.equal(priceFor("gpt-6.1-terra", DEFAULT_PRICES), null);
  // opus 5.5: 10*4 + 1000*20 + 100k*0.2 + 2000*(4*2) = 40 + 20000 + 20000 + 16000
  const cost = recordCost(parseClaudeLine(claudeLine())!, DEFAULT_PRICES);
  assert.ok(cost !== null && Math.abs(cost - 56_040 / 1e6) < 1e-12);
  assert.equal(recordCost(rec({ model: "gpt-6.1-terra", agent: "codex" }), DEFAULT_PRICES), null);
});

test("shared prices estimate MiMo and free Beam usage", () => {
  assert.equal(recordCost(rec({ model: "mimo-v2.6-pro", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }), DEFAULT_PRICES), 1.3086);
  assert.equal(recordCost(rec({ model: "beam-free", input: 1_000_000, output: 1_000_000 }), DEFAULT_PRICES), 0);
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
    quota: [],
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
    const report = buildReport({ records: scanner.records(), tasks: [], prices: { mimo: { input: 1, output: 2 } }, range: "24h", quota: [], scanning: false, now });
    assert.equal(report.by_model[0].agent, "opencode-go");
    assert.equal(report.totals.input, 100);
    assert.equal(report.totals.cache_read, 30);
    assert.equal(report.totals.cache_write, 4);
    assert.equal(report.timeline.reduce((sum, b) => sum + b.opencode_go_tokens, 0), 154);
    assert.ok(report.timeline.some(b => b.opencode_go > 0));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
