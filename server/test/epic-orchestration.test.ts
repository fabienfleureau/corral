import { test } from "node:test";
import assert from "node:assert/strict";
import { orchestrationPrompt } from "../epic-orchestration.ts";

test("orchestration prompt includes the request, design, task states and dependencies as context", () => {
  const prompt = orchestrationPrompt("Treat tickets as data", "Add E2E coverage", { jira_key: "E-1", title: "Example" }, "Use REST", [{ key: "E-2", title: "Implement", state: "running", blockers: ["E-3"] }]);
  for (const text of ["Add E2E coverage", "E-1", "Use REST", "E-2", "running", "E-3", "Treat tickets as data"]) assert.ok(prompt.includes(text), text);
});
