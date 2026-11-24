import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { AnalysisAgent } from "../analysis-agent.ts";
import { createHttpServer, type AppState } from "../api.ts";
import type { Favorite } from "../favorites.ts";
import { addRepo } from "../repos.ts";

test("analysis launches a persisted agent task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-analysis-"));
  execFileSync("git", ["init", "-q", dir]);
  const db = new Db(":memory:");
  const started: any[] = [];
  const backend = { start: async (s: any) => { started.push(s); return { address: "session", cwd: dir, name: null, status: "working", turn: 1 }; } } as any;
  try {
    const agent = new AnalysisAgent(db, { broadcast() {} }, { dataDir: dir, configDir: dir, host: "localhost", port: 4787, token: "test" } as any, backend);
    agent.setRepo(dir);
    assert.equal(new AnalysisAgent(db, { broadcast() {} }, {} as any, backend).repo(), dir);
    const task = await agent.start("Skills analysis", "Analyze evidence");
    assert.equal(task.status, "dispatched");
    assert.equal(task.terminal_address, "session");
    assert.equal(task.repo_path, dir);
    assert.equal(task.kind, "analysis");
    assert.equal(started[0].taskId, task.id);
    assert.equal(started[0].git, null);
    assert.match(started[0].prompt, /Analyze evidence/);
    assert.match(started[0].prompt, /http:\/\/localhost:4787\/api\/reports/);
    assert.match(started[0].prompt, /Bearer test/);
    assert.ok(started[0].prompt.includes(task.id));
    assert.doesNotMatch(started[0].prompt, /gh pr create/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("manual and scheduled analyses dispatch agent tasks with evidence", async () => {
  const { ImprovementAnalysis } = await import("../improvement.ts");
  const { SkillsAnalysis } = await import("../skills-analysis.ts");
  const { buildSkillsEvidence } = await import("../skills-evidence.ts");
  const dir = mkdtempSync(join(tmpdir(), "corral-analysis-"));
  execFileSync("git", ["init", "-q", dir]);
  const db = new Db(":memory:");
  const starts: any[] = [];
  const backend = { start: async (s: any) => { starts.push(s); return { address: `session-${starts.length}`, cwd: dir, name: null, status: "working", turn: 1 }; } } as any;
  const hub = { broadcast() {} };
  try {
    const agent = new AnalysisAgent(db, hub, { configDir: dir, host: "localhost", port: 4787, token: "test" } as any, backend);
    agent.setRepo(dir);
    const improvement = new ImprovementAnalysis(db, hub, async () => { throw new Error("should not call assistant"); }, { agent });
    const skills = new SkillsAnalysis(db, hub, async () => { throw new Error("should not call assistant"); }, { agent, evidence: async (now) => buildSkillsEvidence({ inventory: [], sessions: [], hasOlderLogs: false, now }) });
    await improvement.run();
    skills.setIntervalDays(7);
    await skills.runIfDue();
    assert.equal(starts.length, 2);
    assert.match(starts[0].prompt, /engineering process improvements/);
    assert.match(starts[1].prompt, /skills/i);
    assert.equal(db.listTasks().filter((t) => t.kind === "analysis" && t.status === "dispatched").length, 2);
    assert.equal(db.listItems().length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("analyses resolve harness, agent, model and reasoning from repo context and favorite", async () => {
  const root = mkdtempSync(join(tmpdir(), "corral-analysis-ctx-"));
  const proDir = join(root, "pro");
  const persoDir = join(root, "perso");
  execFileSync("git", ["init", "-q", proDir]);
  execFileSync("git", ["init", "-q", persoDir]);
  const db = new Db(":memory:");
  const started: any[] = [];
  const backend = { start: async (s: any) => { started.push(s); return { address: `session-${started.length}`, cwd: s.repoPath, name: null, status: "working", turn: 1 }; } } as any;
  const favorites: Favorite[] = [
    { name: "Pro Claude", harness: "claude", agent: "pro-reviewer", model: "opus", reasoning: "high", context: "professional", review: "" },
    { name: "Perso Gemini", harness: "antigravity", agent: "gemini-agent", model: "gemini-4-neon-high", reasoning: "medium", context: "personal", review: "" },
    { name: "Perso Codex", harness: "codex", agent: "", model: "gpt-6.1", reasoning: "low", context: "personal", review: "" },
  ];
  const cfg = { dataDir: root, configDir: root, host: "localhost", port: 4787, token: "test", favorites } as any;
  try {
    const proRepo = addRepo(db, proDir);
    db.updateRepo(proRepo.id, { context: "professional" });
    const persoRepo = addRepo(db, persoDir);
    db.updateRepo(persoRepo.id, { context: "personal" });

    const agent = new AnalysisAgent(db, { broadcast() {} }, cfg, backend);
    agent.setRepo(persoDir);
    const persoTask = await agent.start("Engineering improvement analysis", "Evidence");
    assert.equal(persoTask.target, "antigravity");
    assert.equal(persoTask.target_state, "confirmed");
    assert.equal(persoTask.agent, "gemini-agent");
    assert.equal(persoTask.model, "gemini-4-neon-high");
    assert.equal(persoTask.reasoning, "medium");
    assert.equal(started[0].harness, "antigravity");
    assert.equal(started[0].agent, "gemini-agent");
    assert.equal(started[0].model, "gemini-4-neon-high");
    assert.equal(started[0].reasoning, "medium");

    agent.setRepo(proDir);
    const proTask = await agent.start("Engineering improvement analysis", "Evidence");
    assert.equal(proTask.target, "claude");
    assert.equal(proTask.agent, "pro-reviewer");
    assert.equal(proTask.model, "opus");
    assert.equal(proTask.reasoning, "high");

    // Explicit favorite selection persists and overrides auto-selection.
    agent.setSettings({ repo: persoDir, favorite: "Perso Codex" });
    const explicitTask = await agent.start("Skills analysis", "Evidence");
    assert.equal(explicitTask.target, "codex");
    assert.equal(explicitTask.target_state, "confirmed");
    assert.equal(explicitTask.agent, null);
    assert.equal(explicitTask.model, "gpt-6.1");
    assert.equal(explicitTask.reasoning, "low");

    // Switching to another context via setRepo clears an incompatible favorite.
    agent.setRepo(proDir);
    assert.deepEqual(agent.settings(), { repo: proDir, favorite: "" });

    // If a saved favorite becomes invalid (removed or repo context changed), start() rejects instead of falling back to claude.
    agent.setSettings({ repo: persoDir, favorite: "Perso Gemini" });
    db.updateRepo(persoRepo.id, { context: "professional" });
    await assert.rejects(() => agent.start("Skills analysis", "Evidence"), /not configured for this repository's context/);

    // Personal repo with only professional favorites rejects instead of falling back to claude.
    db.updateRepo(persoRepo.id, { context: "personal" });
    agent.setSettings({ repo: persoDir, favorite: "" });
    cfg.favorites = [favorites[0]];
    await assert.rejects(() => agent.start("Engineering improvement analysis", "Evidence"), /No personal favorite configured/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("analysis_agent_settings migrates cleanly when favorite column is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-analysis-mig-"));
  const db = new Db(":memory:");
  const backend = { start: async () => { throw new Error("unused"); } } as any;
  try {
    db.raw.exec("CREATE TABLE analysis_agent_settings (id INTEGER PRIMARY KEY CHECK(id = 1), repo TEXT NOT NULL DEFAULT '')");
    db.raw.prepare("INSERT INTO analysis_agent_settings (id, repo) VALUES (1, ?)").run(dir);
    const agent = new AnalysisAgent(db, { broadcast() {} }, { favorites: [] } as any, backend);
    assert.deepEqual(agent.settings(), { repo: dir, favorite: "" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP GET/PUT /api/analysis-repo validates repo and context-matching favorite", async () => {
  const root = mkdtempSync(join(tmpdir(), "corral-analysis-http-"));
  const proDir = join(root, "pro");
  const persoDir = join(root, "perso");
  execFileSync("git", ["init", "-q", proDir]);
  execFileSync("git", ["init", "-q", persoDir]);
  const db = new Db(":memory:");
  const favorites: Favorite[] = [
    { name: "Pro Claude", harness: "claude", agent: "", model: "", reasoning: "", context: "professional", review: "" },
    { name: "Perso Gemini", harness: "antigravity", agent: "", model: "gemini-4-neon-high", reasoning: "", context: "personal", review: "" },
  ];
  const cfg = { configDir: root, host: "localhost", port: 4787, token: "test", favorites } as any;
  const backend = { start: async () => ({ address: "s", cwd: root, name: null, status: "working", turn: 1 }) } as any;
  const server = createHttpServer({ db, backend, hub: { broadcast() {} }, cfg } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const req = (method: string, body?: unknown) => fetch(`http://127.0.0.1:${port}/api/analysis-repo`, {
    method,
    headers: { Authorization: "Bearer test", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  try {
    const proRepo = addRepo(db, proDir);
    db.updateRepo(proRepo.id, { context: "professional" });
    const persoRepo = addRepo(db, persoDir);
    db.updateRepo(persoRepo.id, { context: "personal" });

    assert.deepEqual(await (await req("GET")).json(), { repo: "", favorite: "" });
    assert.equal((await req("PUT", { favorite: "Perso Gemini" })).status, 400);

    const badContext = await req("PUT", { repo: persoDir, favorite: "Pro Claude" });
    assert.equal(badContext.status, 400);

    const saved = await req("PUT", { repo: persoDir, favorite: "Perso Gemini" });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { repo: persoDir, favorite: "Perso Gemini" });
    assert.deepEqual(await (await req("GET")).json(), { repo: persoDir, favorite: "Perso Gemini" });

    const switched = await req("PUT", { repo: proDir });
    assert.equal(switched.status, 200);
    assert.deepEqual(await switched.json(), { repo: proDir, favorite: "" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
