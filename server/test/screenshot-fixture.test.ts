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
    assert.deepEqual(db.listRepos().map(r => [r.name, r.context]), [["example-project", null], ["side-project", "personal"]]);
  } finally { db.close(); }
});
