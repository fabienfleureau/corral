import assert from "node:assert/strict";
import { test } from "node:test";
import { Db } from "../db.ts";
import { KpiMonitor, parseKpiReport } from "../kpi.ts";
import type { WorkerSession, WorkerStart } from "../worker.ts";

const hour = 3_600_000;
const start = Date.UTC(2026, 10, 18);
const metric = { name: "Example metric", definition: "Compute the change in the net count over a week.", unit: "events", sources: "Fixture event log" };
const report = {
  summary: "The current value is zero.",
  measurement: { value: 0, from: "2026-10-21", to: "2026-11-18", sources: ["Fixture dashboard, metric panel"] },
  dataNeeds: [],
  productQuestions: ["How should duplicate events be counted?"],
  proposals: [],
  memory: "Cross-check counts against the event log.",
};

test("validates generic measurements, windows and evidence in agent output", () => {
  assert.deepEqual(parseKpiReport(JSON.stringify(report), start), report);
  const signed = { ...report, measurement: { ...report.measurement, value: -120.5 } };
  assert.deepEqual(parseKpiReport(JSON.stringify(signed), start), signed);
  assert.throws(() => parseKpiReport(JSON.stringify({
    ...report, measurement: { ...report.measurement, from: "2026-11-31" },
  }), start), /measurement/i);
  assert.throws(() => parseKpiReport(JSON.stringify({
    ...report, measurement: { ...report.measurement, sources: [] },
  }), start), /measurement/i);
  assert.throws(() => parseKpiReport(JSON.stringify({
    ...report, measurement: null, proposals: [{ title: "Fix event pipeline", rationale: "Increase coverage", evidence: "Unverified" }],
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
    for (const id of ["kpi-1", "kpi-2"] as const) {
      const { settings, report } = service.view(id);
      assert.equal(settings.name, "");
      assert.equal(settings.definition, "");
      assert.equal(settings.sources, "");
      assert.equal(report, null);
      assert.throws(() => service.runNow(id), /name and definition/i);
      assert.throws(() => service.configure(id, { ...settings, agent: "analyst", harness: "codex", repo: "/workspace", intervalHours: 1 }), /name and definition/i);
    }
    service.configure("kpi-2", { ...metric, agent: "analyst", harness: "codex", repo: "/workspace", intervalHours: 1, context: "Use the event catalogue." });
    await Promise.all([service.tick(), service.tick(), monitor().tick()]);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].taskId, null);
    assert.match(launches[0].prompt, /Use the event catalogue/);
    assert.match(launches[0].prompt, /net count over a week/);
    assert.match(launches[0].prompt, /Fixture event log/);
    assert.equal(service.view("kpi-2").runState, "running");
    assert.equal(service.view("kpi-1").report, null);

    session = { ...session!, status: "done" };
    await monitor().tick();
    assert.equal(service.view("kpi-2").report?.measurement?.value, 0);
    assert.equal(service.view("kpi-2").report?.productQuestions.length, 1);
    now += hour - 1;
    await service.tick();
    assert.equal(launches.length, 1);
    now++;
    await service.tick();
    assert.equal(launches.length, 2);
    assert.match(launches[1].prompt, /Cross-check counts against the event log/);
    assert.match(launches[1].prompt, /How should duplicate events be counted/);

    session = { ...session!, status: "done" };
    output = JSON.stringify({ ...report, measurement: null, dataNeeds: ["Restore the event connector"] });
    await service.tick();
    assert.equal(service.view("kpi-2").report?.measurement, null);
    assert.equal(service.view("kpi-2").lastMeasurement?.value, 0);
    assert.deepEqual(service.view("kpi-2").report?.dataNeeds, ["Restore the event connector"]);

    await service.runNow("kpi-2");
    session = { ...session!, status: "done" };
    output = "invalid output";
    await service.tick();
    assert.equal(service.view("kpi-2").runState, "failed");
    assert.deepEqual(service.view("kpi-2").report?.dataNeeds, ["Restore the event connector"]);

    service.configure("kpi-2", { ...service.view("kpi-2").settings, definition: "Calculate a different metric." });
    assert.equal(service.view("kpi-2").report, null);
    assert.equal(service.view("kpi-2").lastMeasurement, null);
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
    service.configure("kpi-2", { ...metric, agent: "analyst", harness: "codex", repo: "/workspace", intervalHours: 1, context: "" });
    await service.tick();
    await new KpiMonitor(db, worker, () => start).tick();
    assert.equal(launches, 1);
    assert.equal(service.view("kpi-2").runState, "running");
    assert.equal(service.view("kpi-2").address, "recovered");
  } finally { db.close(); }
});
