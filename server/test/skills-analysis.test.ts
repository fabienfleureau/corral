import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { SkillsAnalysis } from "../skills-analysis.ts";
import { buildSkillsEvidence } from "../skills-evidence.ts";

const NOW = 1_800_000_000_000;

const evidence = async (now: number) => buildSkillsEvidence({
  inventory: [{ name: "debugging", description: "Debug things", origin: "user", where: "~/.claude/skills", plugin: null, modified_ms: now, bytes: 10, head: "Steps" }],
  sessions: [{ agent: "claude", session: "s1", project: "app", first_ms: now - 86_400_000, invocations: [], prompt: "Fix the flaky test" }],
  hasOlderLogs: false,
  now,
});

test("a run stores a digest, sends untrusted-data instructions and changes nothing", async () => {
  const db = new Db(":memory:");
  const broadcasts: string[] = [];
  let prompt = "";
  const service = new SkillsAnalysis(db, { broadcast: (event) => { broadcasts.push(event); } }, async (input) => { prompt = input; return "Proposal: retire nothing yet."; }, { evidence });
  const item = await service.run();
  assert.equal(item.kind, "digest");
  assert.equal(item.title, "Skills analysis");
  assert.match(item.body, /retire nothing yet/);
  assert.match(item.context ?? "", /"debugging"/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /unused since/);
  assert.match(prompt, /Never create, edit or delete files/);
  assert.ok(prompt.includes('"Fix the flaky test"') || prompt.includes("Fix the flaky test"));
  assert.deepEqual(broadcasts, ["item.created"]);
  assert.equal(db.listItems().length, 1);
  assert.equal(service.status().lastSuccessMs !== null, true);
  db.close();
});

test("failures stay visible, retry after an hour and survive a restart", async () => {
  const db = new Db(":memory:");
  const hub = { broadcast() {} };
  const failing = new SkillsAnalysis(db, hub, async () => { throw new Error("assistant unavailable"); }, { evidence });
  failing.setIntervalDays(7);
  await assert.rejects(failing.run(), /assistant unavailable/);
  assert.match(failing.status().error ?? "", /assistant unavailable/);
  assert.equal(db.listItems().length, 0);

  const restarted = new SkillsAnalysis(db, hub, async () => "Keep everything.", { evidence });
  assert.equal(restarted.status().intervalDays, 7);
  await restarted.runIfDue(Date.now() + 60_000);
  assert.equal(db.listItems().length, 0, "a failed run waits out the retry delay");
  await restarted.runIfDue(Date.now() + 3_600_001);
  assert.equal(db.listItems().length, 1);
  assert.equal(restarted.status().error, null);
  await restarted.runIfDue();
  assert.equal(db.listItems().length, 1, "not due again within the interval");
  db.close();
});

test("an empty assistant answer is an error, not a digest", async () => {
  const db = new Db(":memory:");
  const service = new SkillsAnalysis(db, { broadcast() {} }, async () => "  ", { evidence });
  await assert.rejects(service.run(), /empty analysis/);
  assert.equal(db.listItems().length, 0);
  db.close();
});

test("concurrent requests share one run; the schedule stays off by default", async () => {
  const db = new Db(":memory:");
  let release!: (value: string) => void;
  let calls = 0;
  const service = new SkillsAnalysis(db, { broadcast() {} }, () => { calls++; return new Promise((resolve) => { release = resolve; }); }, { evidence });
  assert.equal(service.status().intervalDays, 0);
  await service.runIfDue(NOW);
  assert.equal(calls, 0, "off means no automatic run");
  const first = service.run();
  const second = service.run();
  assert.equal(service.status().running, true);
  await new Promise((resolve) => setImmediate(resolve));
  release("Proposal");
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(db.listItems().length, 1);
  assert.throws(() => service.setIntervalDays(3), /Invalid interval/);
  db.close();
});

test("the skills schedule is independent of the improvement schedule", async () => {
  const db = new Db(":memory:");
  const { ImprovementAnalysis } = await import("../improvement.ts");
  const skills = new SkillsAnalysis(db, { broadcast() {} }, async () => "x", { evidence });
  const improvement = new ImprovementAnalysis(db, { broadcast() {} }, async () => "x");
  skills.setIntervalDays(30);
  assert.equal(improvement.status().intervalDays, 0);
  improvement.setIntervalDays(1);
  assert.equal(skills.status().intervalDays, 30);
  db.close();
});

test("HTTP: status, schedule validation and run", async () => {
  const { createHttpServer } = await import("../api.ts");
  const db = new Db(":memory:");
  const hub = { broadcast() {}, clients: new Set() };
  const skills = new SkillsAnalysis(db, hub, async () => "Draft skill proposals.", { evidence });
  const server = createHttpServer({ db, cfg: { token: "test" }, hub, skills } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/skills-analysis`;
    const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
    const status = await (await fetch(base, { headers })).json() as { intervalDays: number; running: boolean };
    assert.deepEqual([status.intervalDays, status.running], [0, false]);
    const bad = await fetch(base, { method: "PUT", headers, body: JSON.stringify({ intervalDays: 3 }) });
    assert.equal(bad.status, 400);
    const ok = await (await fetch(base, { method: "PUT", headers, body: JSON.stringify({ intervalDays: 7 }) })).json() as { intervalDays: number };
    assert.equal(ok.intervalDays, 7);
    const run = await fetch(`${base}/run`, { method: "POST", headers });
    assert.equal(run.status, 200);
    assert.equal(((await run.json()) as { title: string }).title, "Skills analysis");
    assert.equal((await fetch(base)).status, 401, "the endpoint is authenticated");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test("HTTP: a failing assistant answers 500 with the reason", async () => {
  const { createHttpServer } = await import("../api.ts");
  const db = new Db(":memory:");
  const hub = { broadcast() {}, clients: new Set() };
  const skills = new SkillsAnalysis(db, hub, async () => { throw new Error("assistant unavailable"); }, { evidence });
  const server = createHttpServer({ db, cfg: { token: "test" }, hub, skills } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/skills-analysis`;
    const run = await fetch(`${base}/run`, { method: "POST", headers: { Authorization: "Bearer test" } });
    assert.equal(run.status, 500);
    assert.match(((await run.json()) as { error: string }).error, /assistant unavailable/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
