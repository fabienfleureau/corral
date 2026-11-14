import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSISTANT_PROMPT_OPENERS } from "../assistant-prompts.ts";
import { buildSkillsPrompt } from "../skills-analysis.ts";
import { IMPROVEMENT_OPENER, SKILLS_OPENER, SUMMARIZE_OPENER } from "../assistant-prompts.ts";
import { summarizeText } from "../llm.ts";
import {
  SkillSessionScanner,
  buildSkillsEvidence,
  cleanPrompt,
  inventorySkills,
  parseClaudeSession,
  parseCodexSession,
  parseSkillFile,
  type SessionFacts,
  type SkillInfo,
  type SkillSources,
} from "../skills-evidence.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "corral-skills-"));
}

function writeSkill(dir: string, name: string, frontmatter: string, body = "Do the thing."): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  return path;
}

test("parseSkillFile reads plain, quoted and block-scalar frontmatter", () => {
  assert.deepEqual(parseSkillFile("---\nname: alpha\ndescription: Does alpha things\n---\nBody here"), { name: "alpha", description: "Does alpha things", body: "Body here" });
  assert.equal(parseSkillFile('---\nname: "beta"\ndescription: \'Quoted: value\'\n---\nx').description, "Quoted: value");
  const folded = parseSkillFile("---\nname: gamma\ndescription: >-\n  First line\n  second line\nlicense: MIT\n---\nBody");
  assert.equal(folded.description, "First line second line");
  assert.equal(parseSkillFile("---\ndescription: |\n  One\n  Two\n---\nB").description, "One Two");
  assert.equal(parseSkillFile("No frontmatter at all").name, null);
});

test("inventory dedupes links, skips temp clones, keeps the newest plugin version", () => {
  const root = tmp();
  try {
    const user = join(root, "claude-skills");
    const agents = join(root, "agent-skills");
    const real = writeSkill(agents, "grill", "name: grill\ndescription: Grill me");
    mkdirSync(user, { recursive: true });
    symlinkSync(real, join(user, "grill")); // the same skill reachable from two roots
    writeSkill(user, "own", "name: own\ndescription: My own skill");

    const plugins = join(root, "plugins");
    const v1 = writeSkill(join(plugins, "mkt", "sp", "1.0.0", "skills"), "brainstorm", "name: brainstorm\ndescription: Old");
    const v2 = writeSkill(join(plugins, "mkt", "sp", "2.0.0", "skills"), "brainstorm", "name: brainstorm\ndescription: New");
    utimesSync(join(v1, "SKILL.md"), 1_000, 1_000);
    utimesSync(join(v2, "SKILL.md"), 2_000, 2_000);
    writeSkill(join(plugins, "mkt", "temp_git_123", "1.0.0", "skills"), "ghost", "name: ghost\ndescription: Clone");

    const repo = join(root, "repo");
    writeSkill(join(repo, ".agents", "skills"), "web", "name: web\ndescription: Web guidance");
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    symlinkSync(join(repo, ".agents", "skills", "web"), join(repo, ".claude", "skills", "web"));

    const sources: SkillSources = {
      userRoots: [{ dir: user, label: "~/.claude/skills" }, { dir: agents, label: "~/.agents/skills" }],
      pluginDir: plugins,
      repoPaths: [repo],
      claudeDir: join(root, "none"),
      codexDir: join(root, "none"),
    };
    const skills = inventorySkills(sources);
    const names = skills.map((s) => `${s.origin}:${s.name}`).sort();
    assert.deepEqual(names, ["plugin:brainstorm", "project:web", "user:grill", "user:own"]);
    assert.equal(skills.find((s) => s.name === "brainstorm")?.description, "New");
    assert.equal(skills.find((s) => s.name === "brainstorm")?.plugin, "sp");
    assert.equal(skills.find((s) => s.name === "own")?.head, "Do the thing.");
    assert.equal(skills.find((s) => s.name === "brainstorm")?.head, "", "plugin skill text is not sent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventory tolerates missing roots", () => {
  assert.deepEqual(inventorySkills({ userRoots: [{ dir: "/nonexistent/x", label: "x" }], pluginDir: "/nonexistent/p", repoPaths: ["/nonexistent/r"], claudeDir: "", codexDir: "" }), []);
});

const claudeLine = (obj: Record<string, unknown>) => JSON.stringify({ timestamp: iso(NOW - DAY), cwd: "/work/app", sessionId: "s1", ...obj });

test("claude: only structured invocations count; skill listings in snapshots count zero", () => {
  const listing = "Available skills: brainstorming, debugging, modern-web-guidance";
  const lines = [
    claudeLine({ type: "api-request-shape", shape: { system: [{ type: "text", text: listing }] } }),
    claudeLine({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: [listing, '"name":"Skill" appears in docs'] } }),
    claudeLine({ type: "user", message: { role: "user", content: "Fix the flaky login test" } }),
    claudeLine({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "superpowers:brainstorming" } }] } }),
    claudeLine({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "echo debugging" } }] } }),
    claudeLine({ type: "user", message: { role: "user", content: "<command-message>grill-me</command-message>\n<command-name>/grill-me</command-name>" } }),
    claudeLine({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "see the debugging skill" }] } }),
  ];
  const facts = parseClaudeSession(lines, "s1");
  assert.deepEqual(facts.invocations.map((i) => [i.skill, i.plugin, i.via]), [["brainstorming", "superpowers", "tool"], ["grill-me", null, "slash"]]);
  assert.equal(facts.prompt, "Fix the flaky login test");
  assert.equal(facts.project, "app");
  assert.equal(facts.first_ms, NOW - DAY);

  const listingOnly = parseClaudeSession(lines.slice(0, 2), "s2");
  assert.equal(listingOnly.invocations.length, 0);
});

test("claude: first prompt skips meta, command, sidechain and tool-result messages", () => {
  const facts = parseClaudeSession([
    claudeLine({ type: "user", isMeta: true, message: { role: "user", content: "Caveat: ignore" } }),
    claudeLine({ type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } }),
    claudeLine({ type: "user", isSidechain: true, message: { role: "user", content: "Subagent task" } }),
    claudeLine({ type: "user", message: { role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }] } }),
    claudeLine({ type: "user", message: { role: "user", content: [{ type: "text", text: "Real ask" }] } }),
  ], "s");
  assert.equal(facts.prompt, "Real ask");
});

test("cleanPrompt cuts Corral boilerplate and redacts secrets", () => {
  const dispatched = [
    "\n\n<pasted_content id=\"a1\">",
    "Add a settings page",
    "",
    "---",
    "# Working with Corral",
    "curl -H \"Authorization: Bearer c3f6eb4fce829ec4820b3f4d963985f6d71a1749b631eb44\"",
    "</pasted_content>",
  ].join("\n");
  assert.equal(cleanPrompt(dispatched), "Add a settings page");

  const redacted = cleanPrompt("use Bearer abcdef1234567890 and ghp_abcdefghijklmnop1234 with api_key=hunter2hunter2 at https://bob:pw123@host/x and sha 0123456789abcdef0123456789abcdef01234567") ?? "";
  for (const secret of ["abcdef1234567890", "ghp_abcdefghijklmnop1234", "hunter2hunter2", "bob:pw123", "0123456789abcdef0123456789abcdef01234567"]) {
    assert.ok(!redacted.includes(secret), `${secret} leaked: ${redacted}`);
  }
  assert.equal(cleanPrompt("   "), null);
  assert.ok((cleanPrompt("x".repeat(1000)) ?? "").length <= 280);
});

test("codex: a SKILL.md read counts, the developer skill listing does not", () => {
  const line = (obj: Record<string, unknown>) => JSON.stringify({ timestamp: iso(NOW - 2 * DAY), ...obj });
  const lines = [
    line({ type: "session_meta", payload: { cwd: "/work/api" } }),
    line({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Skills: /home/u/.codex/skills/pr-description/SKILL.md" }] } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /work/api" }] } }),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Run the migration dry run" }] } }),
    line({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "sed -n '1,200p' /Users/u/.codex/skills/.system/plugin-creator/SKILL.md" }) } }),
    line({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls" }) } }),
  ];
  const facts = parseCodexSession(lines, "r1");
  assert.deepEqual(facts.invocations.map((i) => [i.skill, i.via]), [["plugin-creator", "file-read"]]);
  assert.equal(facts.prompt, "Run the migration dry run");
  assert.equal(facts.project, "api");
});

function skill(over: Partial<SkillInfo>): SkillInfo {
  return { name: "s", description: "d", origin: "user", where: "~/.claude/skills", plugin: null, modified_ms: NOW - 200 * DAY, bytes: 100, head: "", ...over };
}

function session(over: Partial<SessionFacts>): SessionFacts {
  return { agent: "claude", session: "s", project: "app", first_ms: NOW - 10 * DAY, invocations: [], prompt: null, ...over };
}

test("evidence attributes uses per skill, plugin and window", () => {
  const inventory = [
    skill({ name: "debugging" }),
    skill({ name: "brainstorming", origin: "plugin", plugin: "superpowers", where: "m/superpowers" }),
    skill({ name: "brainstorming", origin: "plugin", plugin: "other", where: "m/other" }),
    skill({ name: "idle" }),
  ];
  const sessions = [
    session({ session: "a", invocations: [
      { skill: "debugging", plugin: null, ms: NOW - 5 * DAY, via: "tool" },
      { skill: "debugging", plugin: null, ms: NOW - 60 * DAY, via: "slash" },
      { skill: "debugging", plugin: null, ms: NOW - 120 * DAY, via: "tool" }, // outside the 90-day window
      { skill: "brainstorming", plugin: "superpowers", ms: NOW - 2 * DAY, via: "tool" },
      { skill: "model", plugin: null, ms: NOW - DAY, via: "slash" }, // built-in command, not a skill
      { skill: "removed-skill", plugin: null, ms: NOW - DAY, via: "tool" },
    ] }),
    session({ session: "b", invocations: [{ skill: "debugging", plugin: null, ms: NOW - 3 * DAY, via: "tool" }] }),
  ];
  const evidence = buildSkillsEvidence({ inventory, sessions, hasOlderLogs: false, now: NOW });
  const row = (name: string, plugin: string | null = null) => evidence.skills.find((s) => s.name === name && s.plugin === plugin)!;
  assert.equal(row("debugging").uses_window, 3);
  assert.equal(row("debugging").uses_30d, 2);
  assert.equal(row("debugging").sessions_window, 2);
  assert.equal(row("debugging").last_used_ms, NOW - 3 * DAY);
  assert.equal(row("brainstorming", "superpowers").uses_window, 1);
  assert.equal(row("brainstorming", "other").uses_window, 0);
  assert.equal(row("idle").last_used_ms, null);
  assert.deepEqual(evidence.unlisted_invocations.map((u) => u.name), ["removed-skill"]);
  assert.ok(evidence.gaps.some((g) => /never used/.test(g)));
});

test("coverage starts at the earliest log, or at the window when older logs exist", () => {
  const input = { inventory: [], sessions: [session({ first_ms: NOW - 20 * DAY })], now: NOW };
  assert.equal(buildSkillsEvidence({ ...input, hasOlderLogs: false }).coverage_start_ms, NOW - 20 * DAY);
  assert.equal(buildSkillsEvidence({ ...input, hasOlderLogs: true }).coverage_start_ms, NOW - 90 * DAY);
  assert.equal(buildSkillsEvidence({ inventory: [], sessions: [], hasOlderLogs: false, now: NOW }).coverage_start_ms, null);
});

test("evidence dedupes prompts and stays within the size budget", () => {
  const sessions = Array.from({ length: 400 }, (_, i) => session({ session: `s${i}`, first_ms: NOW - (i + 1) * 3_600_000, prompt: `Task ${i}: ${"word ".repeat(55)}` }));
  sessions.push(session({ session: "dup", first_ms: NOW - 1000, prompt: "Task 0: " + "word ".repeat(55) }));
  const inventory = Array.from({ length: 300 }, (_, i) => skill({ name: `skill-${i}`, origin: i % 2 ? "plugin" : "user", plugin: i % 2 ? "p" : null, description: "d".repeat(500), head: "h".repeat(500) }));
  const evidence = buildSkillsEvidence({ inventory, sessions, hasOlderLogs: false, now: NOW });
  assert.ok(JSON.stringify(evidence).length <= evidence.limits.max_chars);
  assert.equal(evidence.truncated.prompts, true);
  assert.equal(evidence.truncated.skills, true);
  assert.equal(new Set(evidence.prompts.map((p) => p.text.slice(0, 80))).size, evidence.prompts.length);
  assert.ok(evidence.skills.every((s) => s.description.length <= 240));
});

test("scanner reads recent logs, caches by size and mtime, and flags older logs", async () => {
  const root = tmp();
  try {
    const claude = join(root, "claude", "proj");
    mkdirSync(claude, { recursive: true });
    const recent = join(claude, "recent.jsonl");
    const old = join(claude, "old.jsonl");
    writeFileSync(recent, [
      claudeLine({ type: "user", message: { role: "user", content: "Do work" } }),
      claudeLine({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "debugging" } }] } }),
    ].join("\n"));
    writeFileSync(old, claudeLine({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "ancient" } }] } }));
    const longAgo = (NOW - 200 * DAY) / 1000;
    utimesSync(old, longAgo, longAgo);
    utimesSync(recent, (NOW - DAY) / 1000, (NOW - DAY) / 1000);

    const scanner = new SkillSessionScanner({ claudeDir: join(root, "claude"), codexDir: join(root, "missing") });
    await scanner.refresh(NOW, true);
    const sessions = scanner.sessions();
    assert.equal(sessions.length, 1, "a file untouched since the window opened is not parsed");
    assert.equal(sessions[0].session, "recent");
    assert.deepEqual(sessions[0].invocations.map((i) => i.skill), ["debugging"]);
    assert.equal(scanner.hasOlderLogs(), true);

    writeFileSync(recent, claudeLine({ type: "user", message: { role: "user", content: "Changed" } }) + "\n");
    utimesSync(recent, (NOW - DAY) / 1000, (NOW - DAY) / 1000);
    await scanner.refresh(NOW, true);
    assert.deepEqual(scanner.sessions()[0].invocations, [], "a changed file is parsed again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Corral's own assistant runs are not the human's sessions", () => {
  const inventory = [skill({ name: "brainstorming" })];
  const headless = (prompt: string, id: string) => session({ session: id, prompt, invocations: [{ skill: "brainstorming", plugin: null, ms: NOW - DAY, via: "tool" }] });
  const sessions = [
    ...ASSISTANT_PROMPT_OPENERS.map((opener, i) => headless(`${opener} More text.`, `assistant-${i}`)),
    session({ session: "human", prompt: "Refactor the billing module", invocations: [{ skill: "brainstorming", plugin: null, ms: NOW - 2 * DAY, via: "tool" }] }),
    // Headless but not Corral's: genuine automation that uses a skill still counts.
    headless("Use the pr-description skill. Draft the MR", "other-headless"),
  ];
  const evidence = buildSkillsEvidence({ inventory, sessions, hasOlderLogs: false, now: NOW });
  assert.equal(evidence.skills[0].uses_window, 2, "the human session and the unrelated headless run");
  assert.equal(evidence.logs.corral_assistant_runs_excluded, 3);
  assert.deepEqual(evidence.prompts.map((p) => p.text).sort(), ["Refactor the billing module", "Use the pr-description skill. Draft the MR"]);
});

test("each Corral prompt builder starts with its opener, so the filter cannot drift", async () => {
  // `echo` as the assistant returns the prompt it was given.
  const sent = await summarizeText({ assistant: ["echo", "{prompt}"] } as never, "some output", "A task");
  assert.ok(sent.startsWith(SUMMARIZE_OPENER));
  const evidence = buildSkillsEvidence({ inventory: [], sessions: [], hasOlderLogs: false, now: NOW });
  assert.ok(buildSkillsPrompt(evidence).startsWith(SKILLS_OPENER));
  assert.equal(new Set([SUMMARIZE_OPENER, IMPROVEMENT_OPENER, SKILLS_OPENER]).size, 3);
});
