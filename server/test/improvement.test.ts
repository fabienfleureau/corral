import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { ImprovementAnalysis } from "../improvement.ts";
import { IMPROVEMENT_OPENER } from "../assistant-prompts.ts";

test("manual analysis creates a digest using bounded evidence and never dispatches", async () => {
  const db = new Db(":memory:");
  let prompt = "";
  const hub = { broadcast() {} };
  const service = new ImprovementAnalysis(db, hub, async (input) => { prompt = input; return "Proposal: examine review delays."; });
  const item = await service.run();
  assert.equal(item.kind, "digest");
  assert.match(item.body, /examine review delays/);
  assert.match(prompt, /evidence/i);
  assert.match(prompt, /do not invent/i);
  assert.ok(prompt.startsWith(IMPROVEMENT_OPENER), "the skills analysis recognizes this run by its opener");
  assert.equal(db.listItems().length, 1);
  db.close();
});

test("scheduled runs persist across restarts and retry failures", async () => {
  const db = new Db(":memory:");
  const hub = { broadcast() {} };
  const service = new ImprovementAnalysis(db, hub, async () => { throw new Error("assistant unavailable"); });
  service.setIntervalDays(7);
  await assert.rejects(service.run(), /assistant unavailable/);
  assert.match(service.status().error ?? "", /assistant unavailable/);
  const restarted = new ImprovementAnalysis(db, hub, async () => "Review the backlog.");
  assert.equal(restarted.status().intervalDays, 7);
  await restarted.runIfDue(Date.now() + 3_600_001);
  assert.equal(db.listItems().length, 1);
  assert.equal(restarted.status().error, null);
  await restarted.runIfDue();
  assert.equal(db.listItems().length, 1);
  db.close();
});

test("concurrent requests share one run", async () => {
  const db = new Db(":memory:");
  let release!: (value: string) => void;
  const service = new ImprovementAnalysis(db, { broadcast() {} }, () => new Promise((resolve) => { release = resolve; }));
  const first = service.run();
  const second = service.run();
  release("Proposal");
  await Promise.all([first, second]);
  assert.equal(db.listItems().length, 1);
  db.close();
});

test("digest evidence carries linked tasks and usage costs", async () => {
  const db = new Db(":memory:");
  const now = Date.now();
  const task = (over: Record<string, unknown>) => ({
    prompt: "Work",
    repo_path: "/repos/app",
    target: "claude",
    target_state: "confirmed",
    base_branch: "main",
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: null,
    pr_meta: null,
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: now - 86_400_000,
    updated_ms: now - 86_400_000,
    ...over,
  });
  db.insertTask(task({ id: "recent", title: "Recent", updated_ms: now, worktree_path: "/work/recent" }) as never);
  db.insertTask(task({ id: "older", title: "Older", updated_ms: now - 60 * 86_400_000 }) as never);
  db.insertItem({
    id: "q1",
    kind: "question",
    status: "open",
    title: "Question",
    summary: "",
    body: "",
    context: "",
    options: null,
    ready: 1,
    source_ref: null,
    task_id: "older",
    structured: 0,
    created_ms: now - 86_400_000,
    updated_ms: now - 86_400_000,
    resolved_ms: null,
    snooze_until_ms: null,
  } as never);

  let prompt = "";
  const service = new ImprovementAnalysis(db, { broadcast() {} }, async (input) => { prompt = input; return "Proposal"; }, {
    usage: async () => ({
      records: [{
        agent: "claude",
        key: "k1",
        ts: now - 3_600_000,
        model: "claude-opus-5",
        cwd: "/work/recent/sub",
        input: 1_000_000,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      }],
      prices: { "claude-opus-5": { input: 5, output: 25 } },
      scanning: false,
    }),
  });
  const item = await service.run();
  const evidence = JSON.parse(item.context);
  assert.ok(evidence.tasks.some((t: { id: string }) => t.id === "older"), "task behind an item is included");
  assert.equal(evidence.usage.by_task[0].id, "recent");
  assert.equal(evidence.tasks.find((t: { id: string }) => t.id === "recent").usage.cost_usd, 5);
  assert.ok(evidence.data_quality);
  assert.match(prompt, /data_quality/);
  assert.match(item.body, /Production outcomes are not collected/);
  db.close();
});
