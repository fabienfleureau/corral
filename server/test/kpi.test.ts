import assert from "node:assert/strict";
import { test } from "node:test";
import { Db } from "../db.ts";
import { KpiMonitor, parseKpiReport } from "../kpi.ts";
import type { WorkerSession, WorkerStart } from "../worker.ts";

const hour = 3_600_000;
const start = Date.UTC(2026, 10, 18);
const report = {
  summary: "Both Tier 1 organisations are below the threshold.",
  measurement: { value: 0, from: "2026-10-21", to: "2026-11-18", sources: ["Deployment dashboard, Tier 1 panel"] },
  dataNeeds: [],
  productQuestions: ["Should retried deployments count once?"],
  proposals: [],
  memory: "Compare against the Tier 1 cohort from the CRM.",
};

test("validates measured zero, rolling windows and evidence in agent output", () => {
  assert.deepEqual(parseKpiReport("tier1", JSON.stringify(report), start), report);
  assert.throws(() => parseKpiReport("tier1", JSON.stringify({
    ...report, measurement: { ...report.measurement, from: "2026-11-01" },
  }), start), /measurement/i);
  assert.throws(() => parseKpiReport("tier1", JSON.stringify({
    ...report, measurement: { ...report.measurement, from: "2026-10-20", to: "2026-11-17" },
  }), start), /measurement/i);
  assert.throws(() => parseKpiReport("qovery-side", JSON.stringify({
    ...report, measurement: { ...report.measurement, sources: [] },
  }), start), /measurement/i);
  assert.throws(() => parseKpiReport("tier1", JSON.stringify({
    ...report, measurement: null, proposals: [{ title: "Fix runner", rationale: "Increase reliability", evidence: "Unverified" }],
  }), start), /proposals/i);
});

test("schedules opted-in KPIs independently and resumes their reports and memory", async () => {
  const db = new Db(":memory:");
  try {
    let now = start;
    const launches: WorkerStart[] = [];
    let session: WorkerSession | null = null;
    let output: string = JSON.stringify(report);
    const worker = {
      start: async (input: WorkerStart) => {
        launches.push(input);
        session = { address: "test-session", name: input.name, status: "working", state: "live" } as WorkerSession;
        return session;
      },
      get: async () => session,
      list: async () => session ? [session] : [],
      lastRunOutcome: async () => ({ kind: "message" as const, text: output }),
    };
    const monitor = () => new KpiMonitor(db, worker, () => now);
    const service = monitor();
    await service.tick();
    assert.equal(launches.length, 0);
    service.configure("tier1", { agent: "reliability", harness: "codex", repo: "/workspace", intervalHours: 1, context: "CRM defines Tier 1." });
    await Promise.all([service.tick(), service.tick(), monitor().tick()]);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].taskId, null);
    assert.match(launches[0].prompt, /CRM defines Tier 1/);
    assert.equal(service.view("tier1").runState, "running");
    assert.equal(service.view("qovery-side").report, null);

    session = { ...session!, status: "done" };
    await monitor().tick();
    assert.equal(service.view("tier1").report?.measurement?.value, 0);
    assert.equal(service.view("tier1").report?.productQuestions.length, 1);
    now += hour - 1;
    await service.tick();
    assert.equal(launches.length, 1);
    now++;
    await service.tick();
    assert.equal(launches.length, 2);
    assert.match(launches[1].prompt, /Compare against the Tier 1 cohort/);
    assert.match(launches[1].prompt, /Should retried deployments count once/);

    session = { ...session!, status: "done" };
    output = JSON.stringify({ ...report, measurement: null, dataNeeds: ["Restore deployment connector"] });
    await service.tick();
    assert.equal(service.view("tier1").report?.measurement, null);
    assert.equal(service.view("tier1").lastMeasurement?.value, 0);
    assert.deepEqual(service.view("tier1").report?.dataNeeds, ["Restore deployment connector"]);

    await service.runNow("tier1");
    session = { ...session!, status: "done" };
    output = "invalid output";
    await service.tick();
    assert.equal(service.view("tier1").runState, "failed");
    assert.deepEqual(service.view("tier1").report?.dataNeeds, ["Restore deployment connector"]);
  } finally { db.close(); }
});

test("an ambiguous launch is recovered by session name without starting another agent", async () => {
  const db = new Db(":memory:");
  try {
    let launches = 0;
    let session: WorkerSession;
    const worker = {
      start: async (input: WorkerStart) => {
        launches++;
        session = { address: "recovered", name: input.name, status: "working", state: "live" } as WorkerSession;
        throw new Error("Connection dropped after session creation");
      },
      get: async () => session,
      list: async () => [session],
      lastRunOutcome: async () => null,
    };
    const service = new KpiMonitor(db, worker, () => start);
    service.configure("tier1", { agent: "reliability", harness: "codex", repo: "/workspace", intervalHours: 1, context: "" });
    await service.tick();
    await new KpiMonitor(db, worker, () => start).tick();
    assert.equal(launches, 1);
    assert.equal(service.view("tier1").runState, "running");
    assert.equal(service.view("tier1").address, "recovered");
  } finally { db.close(); }
});
