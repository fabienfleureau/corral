import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";

test("Jira import saves reviewed task settings and retains stale-preview protection", async () => {
  const db = new Db(":memory:");
  const fields = { title: "Issue", prompt: "Description", jira_key: "ABC-1", jira_url: "https://jira.example/ABC-1", jira_parent_key: null, jira_status: "Open" };
  const jira = { getIssue: async () => ({}), issueToTaskFields: () => fields };
  const server = createHttpServer({ db, jira, cfg: { token: "test" }, hub: { broadcast() {} } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/jira/import`;
    const post = async (item: object) => (await fetch(url, { method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify({ items: [item] }) })).json() as Promise<any>;
    const stale = await post({ key: "ABC-1", fingerprint: "stale", repo_path: "/chosen", target: "codex" });
    assert.equal(stale.changed.length, 1);
    assert.equal(db.listTasks().length, 0);
    const result = await post({ key: "ABC-1", fingerprint: stale.changed[0].fingerprint, repo_path: "/chosen", base_branch: "develop", target: "codex", agent: "reviewer", model: "model-a", reasoning: "high" });
    assert.equal(result.created.length, 1);
    const task = db.getTaskByJiraKey("ABC-1")!;
    assert.deepEqual([task.repo_path, task.base_branch, task.target, task.agent, task.model, task.reasoning], ["/chosen", "develop", "codex", "reviewer", "model-a", "high"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
