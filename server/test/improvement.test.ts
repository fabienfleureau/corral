import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { ImprovementAnalysis } from "../improvement.ts";

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
