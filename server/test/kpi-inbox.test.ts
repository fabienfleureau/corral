import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Db } from "../db.ts";
import { KpiMonitor, parseKpiReport, type KpiDeps } from "../kpi.ts";
import type { Favorite } from "../favorites.ts";
import type { Item, Repo } from "../types.ts";
import type { WorkerSession, WorkerStart } from "../worker.ts";

const start = Date.UTC(2026, 10, 18);
const workspace = mkdtempSync(join(tmpdir(), "corral-kpi-inbox-"));
after(() => rmSync(workspace, { recursive: true, force: true }));
const favorites: Favorite[] = [{ name: "Research", harness: "claude", agent: "", model: "", reasoning: "", context: "professional", review: "" }];
const repo: Repo = { id: "work", name: "work", path: workspace, jira_prefix: null, context: null, source: "manual", created_ms: 0 };
const settings = {
  name: "Failed deployments", definition: "Share of failed deployments per week.", unit: "%", sources: "", context: "",
  repoPath: workspace, favorite: "Research", intervalHours: 0, goal: null,
};
const idea = {
  id: "retry-flaky-pulls", hypothesis: "Image pulls time out on cold nodes.", expectedImpact: "-1 point",
  verification: "Compare failure reasons on cold and warm nodes.", impact: "high", effort: "S", status: "open", reason: "",
};
const base = {
  summary: "Measured.", measurement: null, proposals: [], memory: "",
  dataNeeds: [{ id: "failure-reasons", text: "Export failure reasons per deployment." }],
  productQuestions: [{ id: "count-retries", text: "Do retried deployments count as failed?" }],
  ideas: [idea],
};

function harness() {
  const launches: WorkerStart[] = [];
  const events: [string, Item][] = [];
  let session: WorkerSession | null = null;
  let output = "";
  const worker = {
    start: async (input: WorkerStart) => {
      launches.push(input);
      session = { address: "inbox-session", name: input.name, status: "done", state: "finished" } as WorkerSession;
      return session;
    },
    get: async () => session,
    list: async () => session ? [session] : [],
    lastRunOutcome: async () => ({ kind: "message" as const, text: output }),
  };
  const deps: KpiDeps = { favorites: () => favorites, repos: () => [repo], onItem: (event, item) => events.push([event, item]) };
  const db = new Db(":memory:");
  const service = new KpiMonitor(db, worker, deps, () => start);
  const cycle = async (report: unknown) => {
    output = JSON.stringify(report);
    await service.runNow("kpi-1");
    await service.tick();
  };
  const items = () => db.raw.prepare("SELECT * FROM items ORDER BY created_ms, title").all() as unknown as Item[];
  return { db, service, launches, events, cycle, items };
}

test("ideas and asks are validated", () => {
  const parse = (patch: object) => parseKpiReport(JSON.stringify({ ...base, ...patch }), start);
  assert.deepEqual(parse({}).ideas, [idea]);
  assert.equal("ideas" in parse({ ideas: undefined }), false);
  assert.throws(() => parse({ ideas: [{ ...idea, status: "rejected", reason: "" }] }), /reason/);
  assert.throws(() => parse({ ideas: [idea, idea] }), /unique/);
  assert.throws(() => parse({ ideas: Array.from({ length: 9 }, (_, i) => ({ ...idea, id: `idea-${i}` })) }), /open ideas/);
  assert.throws(() => parse({ ideas: [{ ...idea, effort: "XL" }] }), /effort/);
  assert.throws(() => parse({ dataNeeds: [{ id: "Bad Id", text: "x" }] }), /id/);
  const [plain] = parse({ dataNeeds: ["Export failure reasons per deployment."] }).dataNeeds;
  assert.match(typeof plain === "string" ? "" : plain.id, /^q-[0-9a-f]{10}$/);
  assert.throws(() => parse({ proposals: [], measurement: null, ideas: [], productQuestions: [{ id: "a", text: "" }] }), /product question/);
});

test("each new ask opens one inbox question; dropped asks are archived", async () => {
  const { db, service, cycle, items, events } = harness();
  try {
    service.configure("kpi-1", settings);
    await cycle(base);
    assert.deepEqual(items().map(({ source_ref, status, kind }) => [source_ref, status, kind]).sort(), [
      ["kpi:kpi-1:count-retries", "open", "question"],
      ["kpi:kpi-1:failure-reasons", "open", "question"],
    ]);
    assert.deepEqual(JSON.parse(items()[0].options ?? "[]"), ["Not available", "Out of scope"]);
    assert.match(items()[0].body, /from the KPI Failed deployments/);
    assert.equal(events.filter(([event]) => event === "item.created").length, 2);

    await cycle(base);
    assert.equal(items().length, 2);

    await cycle({ ...base, productQuestions: [] });
    const retries = items().find(({ source_ref }) => source_ref === "kpi:kpi-1:count-retries");
    assert.equal(retries?.status, "archived");
    assert.equal(items().find(({ source_ref }) => source_ref === "kpi:kpi-1:failure-reasons")?.status, "open");
  } finally { db.close(); }
});

test("answers and dismissed ideas reach the next prompt and are not asked again", async () => {
  const { db, service, launches, cycle, items } = harness();
  try {
    service.configure("kpi-1", settings);
    await cycle(base);
    service.answer("kpi:kpi-1:count-retries", "Yes, count every retry.");
    service.dismissIdea("kpi-1", "retry-flaky-pulls", "Pulls are cached already.");
    assert.throws(() => service.dismissIdea("kpi-1", "unknown", ""), /Unknown idea/);
    assert.throws(() => service.answer("kpi:kpi-9:x", "y"), /Not a KPI question/);
    const { feedback } = service.view("kpi-1");
    assert.deepEqual(feedback.map(({ kind, ref, subject, answer }) => [kind, ref, subject, answer]), [
      ["answer", "count-retries", "Do retried deployments count as failed?", "Yes, count every retry."],
      ["dismissed-idea", "retry-flaky-pulls", "Image pulls time out on cold nodes.", "Pulls are cached already."],
    ]);
    // An item resolved by its answer is not recreated when the id comes back.
    db.raw.prepare("UPDATE items SET status = 'resolved' WHERE source_ref = 'kpi:kpi-1:count-retries'").run();
    await cycle(base);
    assert.equal(items().filter(({ source_ref }) => source_ref === "kpi:kpi-1:count-retries").length, 1);
    assert.match(launches[1].prompt, /"feedback":\[\{"kind":"answer","ref":"count-retries"/);
    assert.match(launches[1].prompt, /Never bring back an idea the operator dismissed/);

    service.configure("kpi-1", { ...settings, definition: "Failed deployments per day." });
    assert.deepEqual(service.view("kpi-1").feedback, []);
    assert.equal(items().find(({ source_ref }) => source_ref === "kpi:kpi-1:failure-reasons")?.status, "archived");
  } finally { db.close(); }
});

test("replying to a KPI question records the answer instead of messaging a session", async () => {
  const { createHttpServer } = await import("../api.ts");
  const { db, service, cycle, items } = harness();
  service.configure("kpi-1", settings);
  await cycle(base);
  const sent: string[] = [];
  const server = createHttpServer({
    db, kpis: service, cfg: { token: "test" }, hub: { broadcast() {}, clients: new Set() },
    backend: { send: async (address: string) => { sent.push(address); } },
  } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: object) => fetch(url + path, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const question = items().find(({ source_ref }) => source_ref === "kpi:kpi-1:failure-reasons")!;
    assert.equal((await post(`/api/items/${question.id}/reply`, { text: "Not available" })).status, 200);
    assert.deepEqual(sent, []);
    assert.equal(db.getItem(question.id)?.status, "resolved");
    assert.equal(service.view("kpi-1").feedback[0].answer, "Not available");
    assert.equal((await post(`/api/items/${question.id}/reply`, { text: "Again" })).status, 409);
    assert.equal((await post("/api/kpis/kpi-1/ideas/retry-flaky-pulls/dismiss", { reason: "" })).status, 200);
    assert.equal(service.view("kpi-1").feedback[1].answer, "Dismissed by the operator");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
