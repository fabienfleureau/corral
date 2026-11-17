import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Db } from "../db.ts";
import { seedScreenshotData } from "../../scripts/screenshot-fixture.ts";

test("screenshot fixture includes representative synthetic task settings", () => {
  const db = new Db(":memory:");
  try {
    seedScreenshotData(db);
    const tasks = db.listTasks();
    assert.deepEqual(new Set(tasks.map(t => t.status)), new Set(["open", "dispatched", "done"]));
    assert.ok(tasks.some(t => t.model && t.reasoning));
    assert.ok(tasks.some(t => t.model === null && t.reasoning === null));
    assert.ok(tasks.every(t => t.repo_path.startsWith("/sample/")));
    assert.ok(tasks.some(t => t.jira_key && t.jira_url), "a Jira-imported task carries its ticket link");
    assert.ok(db.listItems({ status: "open" }).some(i => i.task_id === "sample-running"), "an open item from that task");
    assert.equal(db.listItems({ kind: "launch" }).length, 0, "a ready epic task waits on the Epic page, not in the inbox");
    assert.deepEqual(db.listRepos().map(r => [r.name, r.context]), [["example-project", null], ["side-project", "personal"]]);
    const pulls = JSON.parse((db.raw.prepare("SELECT pulls FROM pull_snapshot WHERE id = 1").get() as { pulls: string }).pulls) as { awaitingMe: boolean; isMine: boolean }[];
    assert.ok(pulls.some((p) => p.awaitingMe && p.isMine), "the human's own PR is listed");
    assert.ok(pulls.some((p) => p.awaitingMe && !p.isMine), "a requested review is listed");
    assert.ok(pulls.some((p) => !p.awaitingMe && !p.isMine), "a colleague's PR is listed");
  } finally { db.close(); }
});
