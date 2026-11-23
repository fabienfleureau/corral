import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Db } from "../db.ts";
import { KpiMonitor, parseKpiReport, parseOneTimeInstruction, type KpiDeps } from "../kpi.ts";
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
const workspace = mkdtempSync(join(tmpdir(), "corral-kpi-"));
const work: Repo = { id: "work", name: "work", path: workspace, jira_prefix: null, context: null, source: "manual", created_ms: 0 };
const home: Repo = { ...work, id: "home", name: "home", path: "/sample/home", context: "personal" };
after(() => rmSync(workspace, { recursive: true, force: true }));
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

test("reads a report wrapped in agent prose", () => {
  const fenced = [
    "Measured the metric from the dashboard.",
    "",
    "```json",
    JSON.stringify(report),
    "```",
    "",
    "The JSON is also saved on disk.",
  ].join("\n");
  assert.deepEqual(parseKpiReport(fenced, start), report);
  assert.deepEqual(parseKpiReport(`Notes\n${JSON.stringify(report)}\nThanks`, start), report);
  const earlier = { ...report, measurement: { ...report.measurement, value: 1 } };
  assert.equal(parseKpiReport(`${JSON.stringify(earlier)}\n${JSON.stringify(report)}`, start).measurement?.value, 0);
  const invalid = { ...report, measurement: { ...report.measurement, from: "2026-11-31" } };
  assert.throws(() => parseKpiReport([...fenced.split("\n").slice(0, 3), JSON.stringify(invalid), "```"].join("\n"), start), /measurement/i);
  assert.throws(() => parseKpiReport("No structured report in this message", start), /No KPI report JSON/i);
});

test("a KPI cycle accepts a report wrapped in agent prose", async () => {
  const db = new Db(":memory:");
  try {
    let session: WorkerSession | null = null;
    const output = ["Here is the report.", "```json", JSON.stringify(report), "```"].join("\n");
    const worker = {
      start: async (input: WorkerStart) => {
        session = { address: "prose-session", name: input.name, status: "working", state: "live" } as WorkerSession;
        return session;
      },
      get: async () => session,
      list: async () => session ? [session] : [],
      lastRunOutcome: async () => ({ kind: "message" as const, text: output }),
    };
    const service = new KpiMonitor(db, worker, deps, () => start);
    service.configure("kpi-1", { ...metric, ...agentSettings, intervalHours: 0, context: "" });
    await service.runNow("kpi-1");
    session = { ...session!, status: "done" };
    await service.tick();
    assert.equal(service.view("kpi-1").runState, "complete");
    assert.deepEqual(service.view("kpi-1").report, report);
  } finally { db.close(); }
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
    assert.match(launches[0].prompt, /line breaks.*blank lines/);
    assert.match(launches[0].prompt, /\\n/);
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

test("KPI cycles join the omnigent project of their working directory", async () => {
  const db = new Db(":memory:");
  const unregistered = join(workspace, "unregistered");
  mkdirSync(unregistered, { recursive: true });
  try {
    const launches: WorkerStart[] = [];
    const worker = {
      start: async (input: WorkerStart) => {
        launches.push(input);
        return { address: `session-${launches.length}`, name: input.name, status: "working", state: "live" } as WorkerSession;
      },
      get: async () => null,
      list: async () => [],
    };
    const service = new KpiMonitor(db, worker, deps, () => start);
    service.configure("kpi-1", { ...metric, ...agentSettings, intervalHours: 0, context: "" });
    service.configure("kpi-2", { ...metric, favorite: "Research", repoPath: unregistered, intervalHours: 0, context: "" });
    await service.runNow("kpi-1");
    await service.runNow("kpi-2");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launches.length, 2);
    assert.equal(launches[0].project, work.name);
    assert.equal(launches[0].repoPath, work.path);
    assert.equal(launches[1].project, unregistered);
    assert.equal(launches[1].repoPath, unregistered);
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

test("one-time KPI instructions are sent once, ask the agent to update memory, and are never saved in persistent context", async () => {
  assert.equal(parseOneTimeInstruction(undefined), "");
  assert.equal(parseOneTimeInstruction({}), "");
  assert.equal(parseOneTimeInstruction({ instruction: "  Exclude staging events.  " }), "Exclude staging events.");
  assert.throws(() => parseOneTimeInstruction("bad"), /object/i);
  assert.throws(() => parseOneTimeInstruction({ instruction: 42 }), /one-time instruction/i);
  assert.throws(() => parseOneTimeInstruction({ instruction: "x".repeat(6001) }), /6000/);

  const db = new Db(":memory:");
  try {
    const launches: WorkerStart[] = [];
    let session: WorkerSession;
    const worker = {
      start: async (input: WorkerStart) => {
        launches.push(input);
        session = { address: `inst-${launches.length}`, name: input.name, status: "done", state: "finished" } as WorkerSession;
        return session;
      },
      get: async () => session,
      list: async () => [session],
      lastRunOutcome: async () => ({ kind: "message" as const, text: JSON.stringify(report) }),
    };
    const service = new KpiMonitor(db, worker, deps, () => start);
    service.configure("kpi-1", { ...metric, ...agentSettings, intervalHours: 0, context: "Always use UTC." });

    service.runNow("kpi-1", "Count duplicate events only once per user.");
    await new Promise((resolve) => setImmediate(resolve));
    await service.tick();

    assert.equal(launches.length, 1);
    assert.match(launches[0].prompt, /Always use UTC/);
    assert.match(launches[0].prompt, /One-time operator instruction/);
    assert.match(launches[0].prompt, /Count duplicate events only once per user\./);
    assert.match(launches[0].prompt, /workspace memory file/i);
    assert.equal(service.view("kpi-1").settings.context, "Always use UTC.");

    // Next cycle does not repeat the one-time instruction.
    service.runNow("kpi-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launches.length, 2);
    assert.match(launches[1].prompt, /Always use UTC/);
    assert.doesNotMatch(launches[1].prompt, /One-time operator instruction/);
    assert.doesNotMatch(launches[1].prompt, /Count duplicate events only once per user/);
  } finally { db.close(); }
});
