// Usage stays with its task after the task's worktree is cleaned up, and
// Codex sessions omnigent starts (own CODEX_HOME) are read too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { logTaskEvent, promptData } from "../task-events.ts";
import { DEFAULT_PRICES, UsageScanner, buildReport, buildUsageEvidence, type UsageRecord } from "../usage.ts";
import type { Task } from "../types.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");

function makeTask(over: Partial<Task>): Task {
  return {
    id: "t", title: "Task", prompt: "Task", repo_path: "/repo", target: "claude", target_state: "confirmed",
    base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: null, jira_url: null,
    jira_parent_key: null, pr_url: null, pr_meta: null, status: "open", terminal_address: null, exit_code: null,
    created_ms: NOW, updated_ms: NOW, ...over,
  } as Task;
}

function rec(cwd: string, output: number): UsageRecord {
  return { agent: "claude", key: "", ts: NOW - 3_600_000, model: "claude-opus-5-5", cwd, input: 0, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
}

test("usage stays attributed to a task after its worktree is cleaned up", () => {
  const db = new Db(":memory:");
  // Dispatched in a worktree, then done and cleaned up (worktree_path cleared).
  db.insertTask(makeTask({ id: "cleaned", status: "dispatched" }));
  db.updateTask("cleaned", { worktree_path: "/repo-worktrees/cleaned-1" });
  db.updateTask("cleaned", { status: "done", worktree_path: null });
  // History only in the dispatch prompt event (no worktree_path change logged).
  db.insertTask(makeTask({ id: "prompted", status: "archived" }));
  logTaskEvent(db, "prompted", "prompt", "Initial prompt sent to codex", promptData("go", { worktree: "/repo-worktrees/prompted-2" }));
  // Still live: current worktree.
  db.insertTask(makeTask({ id: "live", status: "dispatched", worktree_path: "/repo-worktrees/live-3" }));
  // Ran in the shared checkout: no reliable key, stays unattributed.
  db.insertTask(makeTask({ id: "shared", status: "done" }));

  const worktrees = db.listTaskWorktrees();
  assert.deepEqual(
    worktrees.map((w) => [w.task_id, w.path]),
    [["cleaned", "/repo-worktrees/cleaned-1"], ["prompted", "/repo-worktrees/prompted-2"]],
  );

  const records = [
    rec("/repo-worktrees/cleaned-1", 1_000_000), // $20
    rec("/repo-worktrees/prompted-2/web", 500_000), // $10
    rec("/repo-worktrees/live-3", 250_000), // $5
    rec("/repo", 100_000), // $2
  ];
  const tasks = db.listTasks();

  const before = buildReport({ records, tasks, prices: DEFAULT_PRICES, range: "7d", scanning: false, now: NOW });
  assert.equal(before.efficiency.tasks_with_spend, 1);

  const report = buildReport({ records, tasks, worktrees, prices: DEFAULT_PRICES, range: "7d", scanning: false, now: NOW });
  assert.equal(report.efficiency.tasks_with_spend, 3);
  assert.equal(report.efficiency.tasks_done, 2);
  assert.ok(Math.abs(report.efficiency.attributed_usd - 35) < 1e-9);
  assert.ok(Math.abs(report.efficiency.unattributed_usd - 2) < 1e-9);
  assert.deepEqual(report.efficiency.top_tasks.map((t) => t.id), ["cleaned", "prompted", "live"]);

  const evidence = buildUsageEvidence({ records, tasks, worktrees, prices: DEFAULT_PRICES, since_ms: NOW - 86_400_000, now: NOW });
  assert.deepEqual(evidence.by_task.map((t) => t.id), ["cleaned", "prompted", "live"]);
  assert.ok(Math.abs(evidence.unattributed_usd - 2) < 1e-9);
});

test("a task's current worktree wins over another task's past one at the same path", () => {
  const tasks = [makeTask({ id: "old" }), makeTask({ id: "new", worktree_path: "/repo-worktrees/x/" })];
  const report = buildReport({
    records: [rec("/repo-worktrees/x", 1_000_000)],
    tasks,
    worktrees: [{ task_id: "old", path: "/repo-worktrees/x" }],
    prices: DEFAULT_PRICES,
    range: "7d",
    scanning: false,
    now: NOW,
  });
  assert.deepEqual(report.efficiency.top_tasks.map((t) => t.id), ["new"]);
});

test("UsageScanner reads Codex sessions under omnigent's codex-native homes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-usage-omni-"));
  try {
    const sessions = join(dir, "omnigent", "codex-native", "abc123", "codex-home", "sessions", "2026", "11", "04");
    mkdirSync(sessions, { recursive: true });
    const lines = [
      { timestamp: "2026-11-04T10:00:00Z", type: "session_meta", payload: { cwd: "/repo-worktrees/codex-task" } },
      { timestamp: "2026-11-04T10:00:01Z", type: "turn_context", payload: { model: "gpt-6.1-sol" } },
      { timestamp: "2026-11-04T10:00:02Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } } } },
    ];
    writeFileSync(join(sessions, "rollout-2026-11-04T10-00-00-x.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const scanner = new UsageScanner({ claudeDir: join(dir, "none"), codexDir: join(dir, "none"), claudeQuotaDir: dir, omnigentDir: join(dir, "omnigent") });
    await scanner.refresh();
    const records = scanner.records();
    assert.equal(records.length, 1);
    assert.equal(records[0].agent, "codex");
    assert.equal(records[0].cwd, "/repo-worktrees/codex-task");
    assert.equal(records[0].output, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
