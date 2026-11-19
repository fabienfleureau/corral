import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Db } from "../db.ts";
import { KpiMonitor, type KpiDeps } from "../kpi.ts";
import { kpiMemoryPath, MAX_MEMORY_CHARS } from "../kpi-memory.ts";
import type { Favorite } from "../favorites.ts";
import type { Repo } from "../types.ts";
import type { WorkerSession, WorkerStart } from "../worker.ts";

const favorites: Favorite[] = [{ name: "Research", harness: "claude", agent: "analyst", model: "opus", reasoning: "high", context: "professional", review: "" }];
const report = {
  summary: "The current value is zero.",
  measurement: { value: 0, from: "2026-10-21", to: "2026-11-18", sources: ["Fixture dashboard"] },
  dataNeeds: [], productQuestions: [], proposals: [], memory: "Cross-check counts against the event log.",
};

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the cycle");
}

function harness() {
  const workspace = mkdtempSync(join(tmpdir(), "corral-kpi-memory-"));
  const repo: Repo = { id: "work", name: "work", path: workspace, jira_prefix: null, context: null, source: "manual", created_ms: 0 };
  const deps: KpiDeps = { favorites: () => favorites, repos: () => [repo] };
  const settings = { name: "Example metric", definition: "Count events over a week.", unit: "events", sources: "Fixture log", repoPath: workspace, favorite: "Research", intervalHours: 0 as const, context: "" };
  const db = new Db(":memory:");
  const prompts: WorkerStart[] = [];
  let session: WorkerSession | null = null;
  let output = JSON.stringify(report);
  const worker = {
    start: async (input: WorkerStart) => {
      prompts.push(input);
      session = { address: "memory-session", name: input.name, status: "working", state: "live" } as WorkerSession;
      return session;
    },
    get: async () => session,
    list: async () => session ? [session] : [],
    lastRunOutcome: async () => ({ kind: "message" as const, text: output }),
  };
  const service = new KpiMonitor(db, worker, deps);
  const finish = async () => {
    await waitFor(() => prompts.length > 0 && Boolean(session));
    session = { ...session!, status: "done" };
    await service.tick();
  };
  return {
    db, prompts, service, finish, workspace, settings,
    setOutput: (text: string) => { output = text; },
    cleanup: () => { db.close(); rmSync(workspace, { recursive: true, force: true }); },
  };
}

test("each KPI gets its own memory file in the working directory", async () => {
  const ctx = harness();
  try {
    const first = kpiMemoryPath("kpi-1", ctx.workspace);
    const second = kpiMemoryPath("kpi-2", ctx.workspace);
    ctx.service.configure("kpi-1", ctx.settings);
    ctx.service.configure("kpi-2", ctx.settings);
    ctx.service.runNow("kpi-1");
    ctx.service.runNow("kpi-2");
    await waitFor(() => ctx.prompts.length === 2 && existsSync(first) && existsSync(second));
    assert.ok(ctx.prompts[0].prompt.includes(first));
    assert.ok(ctx.prompts[1].prompt.includes(second));
    assert.equal(readFileSync(first, "utf8"), "");

    await ctx.finish();
    assert.equal(readFileSync(first, "utf8"), report.memory);
    assert.equal(readFileSync(second, "utf8"), report.memory);
    assert.equal(ctx.service.view("kpi-1").report?.memory, report.memory);
  } finally { ctx.cleanup(); }
});

test("agent edits to the memory file win over the JSON field and reach the next cycle", async () => {
  const ctx = harness();
  const path = kpiMemoryPath("kpi-1", ctx.workspace);
  try {
    ctx.service.configure("kpi-1", ctx.settings);
    ctx.service.runNow("kpi-1");
    await waitFor(() => ctx.prompts.length === 1 && existsSync(path));
    const edited = "Checked the event log; duplicates are excluded after 06:00 UTC.";
    writeFileSync(path, edited);
    ctx.setOutput(JSON.stringify({ ...report, memory: "Short JSON copy" }));
    await ctx.finish();

    assert.equal(readFileSync(path, "utf8"), edited);
    assert.equal(ctx.service.view("kpi-1").report?.memory, edited);
    ctx.service.runNow("kpi-1");
    await waitFor(() => ctx.prompts.length === 2);
    assert.ok(ctx.prompts[1].prompt.includes(edited));
    assert.ok(!ctx.prompts[1].prompt.includes("Short JSON copy"));
  } finally { ctx.cleanup(); }
});

test("changing the definition clears the workspace memory", async () => {
  const ctx = harness();
  const path = kpiMemoryPath("kpi-1", ctx.workspace);
  try {
    ctx.service.configure("kpi-1", ctx.settings);
    ctx.service.runNow("kpi-1");
    await ctx.finish();
    assert.equal(readFileSync(path, "utf8"), report.memory);

    ctx.service.configure("kpi-1", { ...ctx.settings, definition: "Count events over a day." });
    assert.equal(existsSync(path), false);
    assert.equal(ctx.service.view("kpi-1").report, null);

    ctx.service.runNow("kpi-1");
    await waitFor(() => ctx.prompts.length === 2 && existsSync(path));
    assert.equal(readFileSync(path, "utf8"), "");
    assert.ok(ctx.prompts[1].prompt.includes("(empty)"));
  } finally { ctx.cleanup(); }
});

test("a workspace that cannot hold the memory file fails the cycle with a clear error", () => {
  const ctx = harness();
  const blocker = join(ctx.workspace, "not-a-folder");
  writeFileSync(blocker, "occupied");
  try {
    ctx.service.configure("kpi-1", { ...ctx.settings, repoPath: blocker });
    ctx.service.runNow("kpi-1");
    assert.equal(ctx.service.view("kpi-1").runState, "failed");
    assert.match(ctx.service.view("kpi-1").error ?? "", /memory file/i);
  } finally { ctx.cleanup(); }
});

test("a long memory file stays on disk and is bounded in the report", async () => {
  const ctx = harness();
  const path = kpiMemoryPath("kpi-1", ctx.workspace);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const long = "x".repeat(MAX_MEMORY_CHARS + 1_500);
    writeFileSync(path, long);
    ctx.service.configure("kpi-1", ctx.settings);
    ctx.service.runNow("kpi-1");
    await ctx.finish();

    assert.equal(readFileSync(path, "utf8"), long);
    assert.equal(ctx.service.view("kpi-1").report?.memory.length, MAX_MEMORY_CHARS);
  } finally { ctx.cleanup(); }
});
