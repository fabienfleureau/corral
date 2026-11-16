import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { ImprovementAnalysis } from "../improvement.ts";

test("engineering skills analysis uses its own schedule and requests evidence-backed learning", async () => {
  const db = new Db(":memory:");
  let prompt = "";
  const hub = { broadcast() {} };
  const coaching = new ImprovementAnalysis(db, hub, async (input) => { prompt = input; return "Try an exercise."; }, { mode: "engineering-skills" });
  coaching.setIntervalDays(7);
  const process = new ImprovementAnalysis(db, hub, async () => "Process");
  assert.equal(process.status().intervalDays, 0);
  const item = await coaching.run();
  assert.equal(item.title, "Engineering skills analysis");
  assert.match(prompt, /learning topics/i);
  assert.match(prompt, /exercise/i);
  assert.match(prompt, /insufficient/i);
  assert.match(prompt, /untrusted/i);
  db.close();
});
