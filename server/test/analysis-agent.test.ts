import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { AnalysisAgent } from "../analysis-agent.ts";

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
