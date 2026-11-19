import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Db } from "../db.ts";
import { KpiMonitor, parseKpiReport, type KpiDeps } from "../kpi.ts";
import type { Favorite } from "../favorites.ts";
import type { Repo, Task } from "../types.ts";
import type { WorkerSession, WorkerStart } from "../worker.ts";

const day = 86_400_000;
const start = Date.UTC(2026, 10, 18);
const workspace = mkdtempSync(join(tmpdir(), "corral-kpi-impact-"));
after(() => rmSync(workspace, { recursive: true, force: true }));
const favorites: Favorite[] = [{ name: "Research", harness: "claude", agent: "", model: "", reasoning: "", context: "professional", review: "" }];
const repo: Repo = { id: "work", name: "work", path: workspace, jira_prefix: null, context: null, source: "manual", created_ms: 0 };
const deps: KpiDeps = { favorites: () => favorites, repos: () => [repo] };
const settings = {
  name: "Failed deployments", definition: "Share of failed deployments per week.", unit: "%", sources: "", context: "",
  repoPath: workspace, favorite: "Research", intervalHours: 0, goal: null,
};
const report = (impact: unknown[]) => ({
  summary: "Measured.", measurement: null, dataNeeds: [], productQuestions: [], proposals: [], memory: "", impact,
});

function task(id: string): Task {
  return {
    id, title: "Retry image pulls", prompt: "", kind: "code", repo_path: workspace, target: "", target_state: "suggested",
    model: null, reasoning: null, base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: null,
    jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null, status: "open", terminal_address: null, exit_code: null,
    created_ms: start, updated_ms: start,
  } as Task;
}

function harness() {
  let now = start;
  const launches: WorkerStart[] = [];
  let session: WorkerSession | null = null;
  let output = "";
  const worker = {
    start: async (input: WorkerStart) => {
      launches.push(input);
      session = { address: "impact-session", name: input.name, status: "done", state: "finished" } as WorkerSession;
      return session;
    },
    get: async () => session,
    list: async () => session ? [session] : [],
    lastRunOutcome: async () => ({ kind: "message" as const, text: output }),
  };
  const db = new Db(":memory:");
  const service = new KpiMonitor(db, worker, deps, () => now);
  const cycle = async (body: unknown) => {
    output = JSON.stringify(body);
    await service.runNow("kpi-1");
    await service.tick();
  };
  const ship = (id: string, at: number) => db.raw.prepare("INSERT INTO task_events (task_id, ts, kind, message, data) VALUES (?, ?, 'status', 'Status: open → done', ?)")
    .run(id, at, JSON.stringify({ from: "open", to: "done" }));
  return { db, service, launches, cycle, ship, advance: (ms: number) => { now += ms; } };
}

test("impact verdicts are validated", () => {
  assert.deepEqual(parseKpiReport(JSON.stringify(report([{ taskId: "t1", verdict: "none", rationale: "Flat." }])), start).impact,
    [{ taskId: "t1", verdict: "none", rationale: "Flat." }]);
  assert.throws(() => parseKpiReport(JSON.stringify(report([{ taskId: "t1", verdict: "maybe", rationale: "x" }])), start), /impact verdict/);
  assert.throws(() => KpiMonitor.checkLink({ id: "kpi-9", proposal: "x" }), /Unknown KPI/);
  assert.throws(() => KpiMonitor.checkLink({ id: "kpi-1", proposal: "" }), /proposal/);
});

test("a shipped change is followed until three definitive verdicts", async () => {
  const { db, service, launches, cycle, ship } = harness();
  try {
    service.configure("kpi-1", settings);
    db.insertTask(task("t1"));
    service.linkTask("t1", { id: "kpi-1", proposal: "Retry image pulls on timeout" });
    assert.equal(service.view("kpi-1").changes[0].tracking, "waiting");
    await cycle(report([{ taskId: "t1", verdict: "visible", rationale: "Not shipped, ignored." }]));
    assert.match(launches[0].prompt, /"shippedChanges":\[\]/);
    assert.deepEqual(service.view("kpi-1").changes[0].verdicts, []);

    ship("t1", start - 2 * day);
    const shipped = service.view("kpi-1").changes[0];
    assert.equal(shipped.shippedOn, "2026-11-16");
    assert.equal(shipped.tracking, "active");
    await cycle(report([{ taskId: "t1", verdict: "too-early", rationale: "Two days of data." }, { taskId: "other", verdict: "none", rationale: "x" }]));
    assert.match(launches[1].prompt, /"shippedChanges":\[\{"taskId":"t1","title":"Retry image pulls"/);
    for (const verdict of ["visible", "none", "visible"]) await cycle(report([{ taskId: "t1", verdict, rationale: "Compared windows." }]));
    const done = service.view("kpi-1").changes[0];
    assert.deepEqual(done.verdicts.map(({ verdict }) => verdict), ["too-early", "visible", "none", "visible"]);
    assert.equal(done.tracking, "finished");
    await cycle(report([]));
    assert.match(launches.at(-1)!.prompt, /"shippedChanges":\[\]/);

    service.configure("kpi-1", { ...settings, definition: "Failed deployments per day." });
    assert.deepEqual(service.view("kpi-1").changes[0].verdicts, []);
  } finally { db.close(); }
});

test("the follow-up ends 60 days after shipping", () => {
  const { db, service, ship, advance } = harness();
  try {
    db.insertTask(task("t2"));
    service.linkTask("t2", { id: "kpi-1", proposal: "Cache base images" });
    ship("t2", start);
    advance(60 * day);
    assert.equal(service.view("kpi-1").changes[0].tracking, "active");
    advance(1);
    assert.equal(service.view("kpi-1").changes[0].tracking, "finished");
  } finally { db.close(); }
});

test("creating a task from a proposal links it to the KPI", async () => {
  const { createHttpServer } = await import("../api.ts");
  const { db, service } = harness();
  const server = createHttpServer({ db, kpis: service, cfg: { token: "test" }, hub: { broadcast() {}, clients: new Set() }, backend: {} } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: object) => fetch(`${url}/api/tasks`, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ prompt: "Do it", kpi: { id: "kpi-7", proposal: "x" } })).status, 400);
    assert.equal(db.listTasks().length, 0);
    const created = await post({ prompt: "Retry image pulls", kpi: { id: "kpi-1", proposal: "Retry image pulls on timeout" } });
    assert.equal(created.status, 200);
    const { id } = await created.json() as { id: string };
    assert.deepEqual(service.view("kpi-1").changes.map(({ taskId, proposal }) => [taskId, proposal]), [[id, "Retry image pulls on timeout"]]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
