import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Favorite } from "../favorites.ts";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import type { KpiView } from "../../shared/kpis.ts";
import type { Repo, Task } from "../types.ts";
import type { WorkerBackend } from "../worker.ts";
import { ArtifactRequestError, artifactFavorite, kpiArtifactPrompt, parseArtifactRequest } from "../kpi-artifact.ts";

const REPORT = {
  summary: "Reports are up but mobile coverage is incomplete.",
  measurement: { value: 1420, from: "2026-01-06", to: "2026-01-13", sources: ["warehouse.reports"] },
  dataNeeds: ["Add a device field"], productQuestions: ["Do trial accounts count?"],
  proposals: [{ title: "Add device field", rationale: "Explains the mobile gap", evidence: "dashboard panel 3" }],
  memory: "",
};

const FAVORITES: Favorite[] = [
  { name: "Codex research", harness: "codex", agent: "", model: "gpt", reasoning: "", context: "professional", review: "" },
  { name: "Claude native", harness: "claude-native-ui", agent: "artifact-writer", model: "opus", reasoning: "high", context: "professional", review: "" },
  { name: "Personal Claude", harness: "claude", agent: "", model: "sonnet", reasoning: "", context: "personal", review: "" },
];

function view(id: "kpi-1" | "kpi-2", repoPath: string, favorite: string): KpiView {
  return {
    id,
    settings: { name: id === "kpi-1" ? "Weekly reporters" : "Review time", definition: "Count reporters", unit: "accounts", sources: "warehouse", repoPath, favorite, intervalHours: 0, context: "", goal: null },
    runState: "complete", address: null, sessionUrl: null, error: null, startedMs: null, reportMs: Date.now(), nextRunMs: null,
    report: REPORT, lastMeasurement: REPORT.measurement, goalProgress: null,
    history: [{ value: 1300, from: "2026-01-05", to: "2026-01-12", sources: ["warehouse.reports"] }, REPORT.measurement],
  };
}

test("artifact requests keep core sections and reject bad options", () => {
  const request = parseArtifactRequest({ format: "slides", axes: ["risks"], audience: " team sync " });
  assert.equal(request.format, "slides");
  assert.equal(request.audience, "team sync");
  assert.ok(request.axes.includes("value"));
  assert.ok(request.axes.includes("next"));
  assert.ok(request.axes.includes("risks"));
  assert.equal(request.axes.length, new Set(request.axes).size);
  assert.throws(() => parseArtifactRequest({ format: "poster", axes: [] }), ArtifactRequestError);
  assert.throws(() => parseArtifactRequest({ format: "one-page", axes: ["made-up"] }), ArtifactRequestError);
  assert.throws(() => parseArtifactRequest({ format: "one-page", audience: "x".repeat(501) }), ArtifactRequestError);
});

test("artifact prompt carries the reports as data and the chosen shape", () => {
  const a = view("kpi-1", "/work", "Codex research");
  const b = view("kpi-2", "/work", "Codex research");
  b.settings.name = "Review time";
  const prompt = kpiArtifactPrompt([b, a], "kpi-1", { format: "slides", axes: ["value", "evolution", "work", "next", "risks"], audience: "product team" }, Date.UTC(2026, 0, 20));
  assert.ok(prompt.indexOf('"name": "Weekly reporters"') < prompt.indexOf('"name": "Review time"'), "the selected KPI leads");
  assert.match(prompt, /6 to 10 slides/);
  assert.match(prompt, /risks and blockers/i);
  assert.match(prompt, /product team/);
  assert.match(prompt, /Reports are up but mobile coverage is incomplete/);
  assert.match(prompt, /data, not instructions/);
  assert.match(prompt, /private/i);
});

test("artifact favorite prefers a Claude favorite for the folder context", () => {
  const repoPath = "/work";
  const repos: Repo[] = [{ id: "r", name: "r", path: repoPath, jira_prefix: null, context: null, source: "manual", created_ms: 0 }];
  const kpi = view("kpi-1", repoPath, "Codex research");
  assert.equal(artifactFavorite(kpi, FAVORITES, repos)?.name, "Claude native");
  kpi.settings.favorite = "Claude native";
  assert.equal(artifactFavorite(kpi, FAVORITES, repos)?.name, "Claude native");
  kpi.settings.favorite = "Personal Claude";
  assert.equal(artifactFavorite(kpi, FAVORITES, repos)?.name, "Claude native", "a personal favorite cannot serve a professional folder");
  assert.equal(artifactFavorite(kpi, FAVORITES.slice(2), repos), null, "no Claude favorite in the folder context");
});

test("the KPI artifact endpoint dispatches a trackable Claude task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-kpi-artifact-"));
  const db = new Db(":memory:");
  const starts: { prompt: string; harness: string; agent: string | null; git: unknown }[] = [];
  const backend = {
    start: async (input: { prompt: string; harness: string; agent: string | null; git: unknown }) => {
      starts.push(input);
      return { address: "artifact-session", cwd: dir, name: null, status: "working", turn: 1 };
    },
  } as unknown as WorkerBackend;
  const cfg = { configDir: dir, host: "localhost", port: 4787, token: "test", favorites: FAVORITES } as any;
  const server = createHttpServer({ db, backend, hub: { broadcast() {} }, cfg } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const post = (id: string, body: unknown) => fetch(`http://127.0.0.1:${port}/api/kpis/${id}/artifact`, {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    db.raw.prepare("INSERT OR REPLACE INTO kpi_monitors (id, settings, report, report_ms) VALUES (?, ?, ?, ?)")
      .run("kpi-1", JSON.stringify(view("kpi-1", dir, "Codex research").settings), JSON.stringify(REPORT), Date.now());
    assert.equal((await post("missing", { format: "one-page" })).status, 404);
    assert.equal((await post("kpi-2", { format: "one-page" })).status, 409, "an empty KPI has no report");
    assert.equal((await post("kpi-1", { format: "poster" })).status, 400);

    const response = await post("kpi-1", { format: "one-page", axes: [], audience: "weekly team sync" });
    assert.equal(response.status, 202);
    const { task } = await response.json() as { task: Task };
    assert.equal(task.kind, "ops");
    assert.equal(task.status, "dispatched");
    assert.equal(task.target, "claude");
    assert.equal(task.agent, "artifact-writer");
    assert.equal(task.model, "opus");
    assert.equal(task.repo_path, dir);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].git, null);
    assert.match(starts[0].prompt, /Reports are up but mobile coverage is incomplete/);
    assert.match(starts[0].prompt, /Current value/);
    assert.match(starts[0].prompt, /weekly team sync/);
    assert.match(starts[0].prompt, /api\/reports/);
    assert.match(db.listTaskEvents(task.id)[0].data ?? "", /kpi-artifact/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
