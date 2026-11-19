import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Db } from "../db.ts";
import { KpiMonitor, parseKpiReport, type KpiDeps } from "../kpi.ts";
import type { KpiGoal } from "../../shared/kpis.ts";
import type { Favorite } from "../favorites.ts";
import type { Repo } from "../types.ts";
import type { WorkerSession, WorkerStart } from "../worker.ts";

const day = 86_400_000;
const start = Date.UTC(2026, 10, 18);
const workspace = mkdtempSync(join(tmpdir(), "corral-kpi-goal-"));
after(() => rmSync(workspace, { recursive: true, force: true }));
const favorites: Favorite[] = [{ name: "Research", harness: "claude", agent: "", model: "", reasoning: "", context: "professional", review: "" }];
const repo: Repo = { id: "work", name: "work", path: workspace, jira_prefix: null, context: null, source: "manual", created_ms: 0 };
const deps: KpiDeps = { favorites: () => favorites, repos: () => [repo] };
const settings = {
  name: "Failed deployments", definition: "Share of failed deployments per week.", unit: "%", sources: "", context: "",
  repoPath: workspace, favorite: "Research", intervalHours: 0, goal: null as KpiGoal | null,
};
const goal: KpiGoal = { target: 2, direction: "decrease", deadline: "2027-03-01", why: "Customers churn after repeated failures." };
const measured = (value: number, from: string, to: string) => ({
  summary: "Measured.", measurement: { value, from, to, sources: ["Fixture dashboard"] },
  dataNeeds: [], productQuestions: [], proposals: [], memory: "",
  trajectory: { onTrack: "no", confidence: "medium", rationale: "Flat for three weeks." },
  goalReview: { verdict: "ambitious", rationale: "Needs a halving." },
});

function harness(now: () => number) {
  const launches: WorkerStart[] = [];
  let session: WorkerSession | null = null;
  let output = "";
  const worker = {
    start: async (input: WorkerStart) => {
      launches.push(input);
      session = { address: "goal-session", name: input.name, status: "done", state: "finished" } as WorkerSession;
      return session;
    },
    get: async () => session,
    list: async () => session ? [session] : [],
    lastRunOutcome: async () => ({ kind: "message" as const, text: output }),
  };
  const db = new Db(":memory:");
  const service = new KpiMonitor(db, worker, deps, now);
  const cycle = async (report: unknown) => {
    output = JSON.stringify(report);
    await service.runNow("kpi-1");
    await service.tick();
  };
  return { db, service, launches, cycle };
}

test("goal settings are validated", () => {
  const { db, service } = harness(() => start);
  try {
    assert.equal(service.configure("kpi-1", settings).settings.goal, null);
    assert.deepEqual(service.configure("kpi-1", { ...settings, goal }).settings.goal, goal);
    assert.throws(() => service.configure("kpi-1", { ...settings, goal: { ...goal, target: "2" } }), /target/);
    assert.throws(() => service.configure("kpi-1", { ...settings, goal: { ...goal, direction: "up" } }), /direction/);
    assert.throws(() => service.configure("kpi-1", { ...settings, goal: { ...goal, deadline: "2027-02-30" } }), /deadline/);
  } finally { db.close(); }
});

test("goal fields in a report are optional and validated", () => {
  const report = measured(4, "2026-11-01", "2026-11-08");
  assert.deepEqual(parseKpiReport(JSON.stringify(report), start).trajectory, report.trajectory);
  const { trajectory: _t, goalReview: _g, ...plain } = report;
  assert.equal("trajectory" in parseKpiReport(JSON.stringify(plain), start), false);
  assert.equal(parseKpiReport(JSON.stringify({ ...report, trajectory: null }), start).trajectory, null);
  assert.throws(() => parseKpiReport(JSON.stringify({ ...report, trajectory: { ...report.trajectory, onTrack: "maybe" } }), start), /trajectory/);
  assert.throws(() => parseKpiReport(JSON.stringify({ ...report, goalReview: { verdict: "easy", rationale: "x" } }), start), /goal review/);
});

test("the baseline comes from the last measurement, else the first one after the goal", async () => {
  let now = start;
  const { db, service, launches, cycle } = harness(() => now);
  try {
    service.configure("kpi-1", { ...settings, goal });
    assert.deepEqual(service.view("kpi-1").goalProgress, { baseline: null, gap: null, progress: null, reached: false });
    await cycle(measured(5, "2026-11-04", "2026-11-11"));
    assert.deepEqual(service.view("kpi-1").goalProgress, { baseline: { value: 5, to: "2026-11-11" }, gap: -3, progress: 0, reached: false });
    assert.equal(service.view("kpi-1").report?.trajectory?.onTrack, "no");
    assert.match(launches[0].prompt, /Customers churn after repeated failures/);

    now += 7 * day;
    await cycle(measured(3.5, "2026-11-11", "2026-11-18"));
    const progress = service.view("kpi-1").goalProgress;
    assert.equal(progress?.progress, 0.5);
    assert.equal(progress?.baseline?.value, 5);
    assert.match(launches[1].prompt, /"recentMeasurements":\[\{"value":5,"from":"2026-11-04","to":"2026-11-11"\}\]/);
    assert.match(launches[1].prompt, /"goalProgress":\{"baseline":\{"value":5/);

    // Editing the target keeps the baseline; clearing the goal drops it.
    service.configure("kpi-1", { ...settings, goal: { ...goal, target: 1 } });
    assert.equal(service.view("kpi-1").goalProgress?.baseline?.value, 5);
    service.configure("kpi-1", settings);
    assert.equal(service.view("kpi-1").goalProgress, null);
    service.configure("kpi-1", { ...settings, goal });
    assert.deepEqual(service.view("kpi-1").goalProgress?.baseline, { value: 3.5, to: "2026-11-18" });
  } finally { db.close(); }
});

test("history keeps one value per window and resets with the definition", async () => {
  const { db, service, cycle } = harness(() => start);
  try {
    service.configure("kpi-1", settings);
    await cycle(measured(5, "2026-11-04", "2026-11-11"));
    await cycle(measured(4, "2026-11-04", "2026-11-11"));
    await cycle(measured(3, "2026-11-11", "2026-11-18"));
    assert.deepEqual(service.view("kpi-1").history.map(({ value, to }) => [value, to]), [[4, "2026-11-11"], [3, "2026-11-18"]]);
    // Without a goal, goal fields are dropped and the prompt asks for null.
    assert.equal("trajectory" in (service.view("kpi-1").report ?? {}), false);
    service.configure("kpi-1", { ...settings, definition: "Failed deployments per day." });
    assert.deepEqual(service.view("kpi-1").history, []);
  } finally { db.close(); }
});

test("a goal saved over a definition change waits for a new measurement", async () => {
  const { db, service, cycle } = harness(() => start);
  try {
    service.configure("kpi-1", settings);
    await cycle(measured(5, "2026-11-04", "2026-11-11"));
    service.configure("kpi-1", { ...settings, unit: "count", goal });
    assert.equal(service.view("kpi-1").goalProgress?.baseline, null);
  } finally { db.close(); }
});
