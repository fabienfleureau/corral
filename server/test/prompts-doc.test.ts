// docs/prompts.md is the registry of every prompt Corral sends. This test keeps
// it from drifting: a new skills/*.md file must be listed there, a listed file
// must exist, the inline prompt builders must stay documented, and the README
// must link the page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const docPath = join(root, "docs", "prompts.md");
const doc = readFileSync(docPath, "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");

test("prompts doc: every skills/*.md prompt is in the registry", () => {
  const files = readdirSync(join(root, "skills")).filter((f) => f.endsWith(".md"));
  assert.ok(files.length > 0, "no skills/*.md found");
  for (const file of files) {
    assert.ok(doc.includes(`skills/${file}`), `docs/prompts.md does not list skills/${file}`);
  }
});

test("prompts doc: every prompt file it lists exists", () => {
  const listed = [...doc.matchAll(/skills\/([A-Za-z0-9._-]+\.md)/g)].map((m) => m[1]);
  assert.ok(listed.length > 0, "docs/prompts.md lists no skills/*.md file");
  const files = new Set(readdirSync(join(root, "skills")));
  for (const name of new Set(listed)) {
    assert.ok(files.has(name), `docs/prompts.md lists skills/${name}, which does not exist`);
  }
});

test("prompts doc: the inline prompt builders are documented", () => {
  // Each builder lives in code, not in skills/, so the page names it explicitly.
  const builders: [string, string][] = [
    ["questionConvention", "server/dispatch.ts"],
    ["commentsSection", "server/pr.ts"],
    ["conflictSection", "server/pr.ts"],
    ["planRevisionPrompt", "server/multi-repo.ts"],
    ["stoppedRetryPrompt", "server/stopped-retry.ts"],
    ["summarizeText", "server/llm.ts"],
    ["dailySummaryPrompt", "server/daily-summary.ts"],
    ["ImprovementAnalysis", "server/improvement.ts"],
    ["SkillsAnalysis", "server/skills-analysis.ts"],
    ["epicAgentPrompt", "server/epic-agent.ts"],
  ];
  for (const [name, file] of builders) {
    assert.ok(readFileSync(join(root, file), "utf8").includes(name), `${file} no longer contains ${name} — update docs/prompts.md`);
    assert.ok(doc.includes(name), `docs/prompts.md does not document the ${name} prompt (${file})`);
    assert.ok(doc.includes(file), `docs/prompts.md does not point at ${file} for ${name}`);
  }
});

test("prompts doc: reachable from the README", () => {
  assert.ok(readme.includes("docs/prompts.md"), "README.md does not link docs/prompts.md");
});
