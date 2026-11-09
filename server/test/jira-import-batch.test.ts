import { test } from "node:test";
import assert from "node:assert/strict";
import { batchImportItems } from "../../web/src/jira-import.ts";

test("batch settings apply to every reviewed ticket and preserve mapped repos by default", () => {
  const tickets = [{ jira_key: "A-1", fingerprint: "one" }, { jira_key: "B-2", fingerprint: "two" }];
  const settings = { repo_path: "", base_branch: "develop", target: "codex", agent: "reviewer", model: "m", reasoning: "high" };
  const mapped = batchImportItems(tickets, settings);
  assert.deepEqual(mapped.map((item) => item.repo_path), [undefined, undefined]);
  const chosen = batchImportItems(tickets, { ...settings, repo_path: "/chosen" });
  assert.deepEqual(chosen, [
    { key: "A-1", fingerprint: "one", ...settings, repo_path: "/chosen" },
    { key: "B-2", fingerprint: "two", ...settings, repo_path: "/chosen" },
  ]);
});
