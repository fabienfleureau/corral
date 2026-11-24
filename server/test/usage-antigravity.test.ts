// Antigravity usage: per-step tokens from transcript_full.jsonl, workspace
// from the home's conversation summaries, priced from Google's list price.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PRICES, UsageScanner, buildReport, parseAntigravityLines, recordCost } from "../usage.ts";
import type { Task } from "../types.ts";

const user = (i: number) => JSON.stringify({ step_index: i, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-24T15:06:44Z", content: "do it" });
const model = (i: number, m: string, input: number, cache: number, output: number) =>
  JSON.stringify({ step_index: i, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-24T15:06:50Z", model: m, input_tokens: input, cache_read_tokens: cache, output_tokens: output });

test("parseAntigravityLines: one record per model step, cache reads kept apart from input", () => {
  const records = parseAntigravityLines([user(0), model(1, "gemini-4-neon-medium", 2675, 2542, 27), "not json"], "conv", "/w");
  assert.equal(records.length, 1);
  assert.deepEqual(
    [records[0].agent, records[0].key, records[0].model, records[0].input, records[0].cacheRead, records[0].output, records[0].cwd],
    ["antigravity", "antigravity:conv:1", "gemini-4-neon-medium", 2675, 2542, 27, "/w"],
  );
});

test("Gemini 4 models are priced from the base model's list price", () => {
  const rec = parseAntigravityLines([model(1, "gemini-4-hydrogen-tiered-high", 1_000_000, 1_000_000, 1_000_000)], "c", "")[0];
  assert.equal(recordCost(rec, DEFAULT_PRICES), 1.5 + 0.075 + 7.5);
  const neon = parseAntigravityLines([model(1, "gemini-4-neon-medium", 1_000_000, 0, 1_000_000)], "c", "")[0];
  assert.equal(recordCost(neon, DEFAULT_PRICES), 18);
  const flash = parseAntigravityLines([model(1, "gemini-3.8-flash-high", 1_000_000, 0, 1_000_000)], "c", "")[0];
  assert.equal(recordCost(flash, DEFAULT_PRICES), 4.5);
});

test("UsageScanner reads omnigent Antigravity sessions and attributes them by workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-usage-agy-"));
  try {
    const worktree = join(dir, "repo-worktrees", "task-1");
    const home = join(dir, "antigravity-native", "sess1", "agy-home", ".gemini", "antigravity-cli");
    const logs = (conv: string) => {
      const p = join(home, "brain", conv, ".system_generated", "logs");
      mkdirSync(p, { recursive: true });
      return p;
    };
    const main = [user(0), model(1, "gemini-4-neon-medium", 1000, 0, 100), model(3, "gemini-4-neon-medium", 500, 1000, 50)].join("\n") + "\n";
    writeFileSync(join(logs("main"), "transcript_full.jsonl"), main);
    writeFileSync(join(logs("main"), "transcript.jsonl"), main); // same steps, must not count twice
    writeFileSync(join(logs("sub"), "transcript_full.jsonl"), model(1, "gemini-4-hydrogen-high", 200, 0, 20) + "\n");
    const db = new DatabaseSync(join(home, "conversation_summaries.db"));
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)");
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run("main", JSON.stringify([pathToFileURL(worktree).href]));
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run("sub", "");
    db.close();

    const scanner = new UsageScanner({ claudeDir: join(dir, "none"), codexDir: join(dir, "none"), claudeQuotaDir: dir, antigravityDirs: [join(dir, "antigravity-native")] });
    await scanner.refresh();
    const records = scanner.records();
    assert.equal(records.length, 3);
    assert.ok(records.every((r) => r.agent === "antigravity" && r.cwd === worktree));

    const now = Date.parse("2026-11-24T18:00:00Z");
    const task = { id: "t1", title: "t1", prompt: "", status: "done", worktree_path: worktree } as Task;
    const report = buildReport({ records, tasks: [task], prices: DEFAULT_PRICES, range: "24h", scanning: false, now });
    assert.equal(report.totals.unpriced_calls, 0);
    assert.equal(report.by_agent[0].agent, "antigravity");
    assert.equal(report.efficiency.top_tasks[0].agent, "antigravity");
    assert.ok(report.timeline.some((b) => b.antigravity > 0 && b.antigravity_tokens === 2870));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
