import assert from "node:assert/strict";
import { test } from "node:test";
import { Db } from "../db.ts";
import { KpiMonitor, parseKpiReport, type KpiDeps } from "../kpi.ts";
import type { Favorite } from "../favorites.ts";
import type { Repo } from "../types.ts";
import type { WorkerSession, WorkerStart } from "../worker.ts";

const hour = 3_600_000;
const start = Date.UTC(2026, 10, 18);
const metric = { name: "Example metric", definition: "Compute the change in the net count over a week.", unit: "events", sources: "Fixture event log" };
const favorites: Favorite[] = [
  { name: "Research", harness: "claude", agent: "analyst", model: "opus", reasoning: "high", context: "professional", review: "" },
  { name: "Home research", harness: "codex", agent: "", model: "", reasoning: "", context: "personal", review: "" },
];
const work: Repo = { id: "work", name: "work", path: "/sample/work", jira_prefix: null, context: null, source: "manual", created_ms: 0 };
const home: Repo = { ...work, id: "home", name: "home", path: "/sample/home", context: "personal" };
const deps: KpiDeps = { favorites: () => favorites, repos: () => [work, home] };
const agentSettings = { favorite: "Research", repoPath: work.path };
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
    const monitor = () => new KpiMonitor(db, worker, deps, () => now);
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
      assert.throws(() => service.configure(id, { ...settings, ...agentSettings, intervalHours: 1 }), /name and definition/i);
    }
    service.configure("kpi-2", { ...metric, ...agentSettings, intervalHours: 1, context: "Use the event catalogue." });
    await Promise.all([service.tick(), service.tick(), monitor().tick()]);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].taskId, null);
    assert.equal(launches[0].repoPath, work.path);
    assert.equal(launches[0].harness, "claude");
    assert.equal(launches[0].agent, "analyst");
    assert.equal(launches[0].model, "opus");
    assert.equal(launches[0].reasoning, "high");
    assert.equal(launches[0].git, null);
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
    const service = new KpiMonitor(db, worker, deps, () => start);
    service.configure("kpi-2", { ...metric, ...agentSettings, intervalHours: 1, context: "" });
    await service.tick();
    await new KpiMonitor(db, worker, deps, () => start).tick();
    assert.equal(launches, 1);
    assert.equal(service.view("kpi-2").runState, "running");
    assert.equal(service.view("kpi-2").address, "recovered");
  } finally { db.close(); }
});

test("a definition can be saved before the agent picks a folder and favorite", () => {
  const db = new Db(":memory:");
  try {
    const service = new KpiMonitor(db, {} as KpiMonitor["worker"], deps);
    const saved = service.configure("kpi-1", { ...metric, favorite: "", repoPath: "", intervalHours: 0, context: "" });
    assert.equal(saved.settings.favorite, "");
    assert.throws(() => service.runNow("kpi-1"), /working directory/i);
    service.configure("kpi-1", { ...saved.settings, repoPath: work.path });
    assert.throws(() => service.runNow("kpi-1"), /favorite/i);
    assert.throws(() => service.configure("kpi-1", { ...saved.settings, ...agentSettings, repoPath: "relative/path" }), /absolute/i);
    assert.throws(() => service.configure("kpi-1", { ...saved.settings, ...agentSettings, repoPath: home.path }), /not configured/i);
    assert.equal(service.configure("kpi-1", { ...saved.settings, ...agentSettings }).settings.favorite, "Research");
  } finally { db.close(); }
});

test("old agent settings keep the folder and ask for a favorite", () => {
  const db = new Db(":memory:");
  try {
    const service = new KpiMonitor(db, {} as KpiMonitor["worker"], deps);
    db.raw.prepare("UPDATE kpi_monitors SET settings = ? WHERE id = ?")
      .run(JSON.stringify({ ...metric, agent: "analyst", harness: "codex", repo: "/old/folder", intervalHours: 0, context: "" }), "kpi-1");
    const { settings } = service.view("kpi-1");
    assert.equal(settings.repoPath, "/old/folder");
    assert.equal(settings.favorite, "");
    assert.throws(() => service.runNow("kpi-1"), /favorite/i);
  } finally { db.close(); }
});

test("the favorite is resolved at launch, not copied into the settings", async () => {
  const db = new Db(":memory:");
  try {
    const launches: WorkerStart[] = [];
    let session: WorkerSession;
    const worker = {
      start: async (input: WorkerStart) => {
        launches.push(input);
        session = { address: "favorite-session", name: input.name, status: "done", state: "finished" } as WorkerSession;
        return session;
      },
      get: async () => session,
      list: async () => [session],
      lastRunOutcome: async () => ({ kind: "message" as const, text: JSON.stringify(report) }),
    };
    const editable = favorites.map((favorite) => ({ ...favorite }));
    const service = new KpiMonitor(db, worker, { favorites: () => editable, repos: () => [work, home] }, () => start);
    service.configure("kpi-1", { ...metric, ...agentSettings, intervalHours: 0, context: "" });
    await service.runNow("kpi-1");
    await service.tick();
    editable[0] = { ...editable[0], model: "sonnet", reasoning: "low" };
    await service.runNow("kpi-1");
    await service.tick();
    assert.equal(launches.length, 2);
    assert.equal(launches[1].model, "sonnet");
    assert.equal(launches[1].reasoning, "low");
  } finally { db.close(); }
});
