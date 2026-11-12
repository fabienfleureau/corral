import { test } from "node:test";
import assert from "node:assert/strict";

const { Db } = await import("../db.ts");

test("repeated queries reuse one compiled statement", () => {
  const db = new Db(":memory:");
  let prepared = 0;
  const prepare = db.raw.prepare.bind(db.raw);
  (db.raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    prepared++;
    return prepare(sql);
  };
  try {
    for (let i = 0; i < 5; i++) {
      db.listTasks();
      db.listItems({ status: "open" });
      db.getTerminal("nope");
    }
    assert.equal(prepared, 3, "three query shapes, compiled once each");
    for (let i = 0; i < 5; i++) {
      db.listTasks();
      db.listItems({ status: "open" });
      db.getTerminal("nope");
    }
    assert.equal(prepared, 3, "a warm cache compiles nothing");

    db.listTasks("open");
    assert.equal(prepared, 4, "a new query shape compiles once");
    for (let i = 0; i < 5; i++) db.listTasks("open");
    assert.equal(prepared, 4, "and is then reused");
  } finally {
    db.close();
  }
});

test("cached statements stay correct for writes and dynamic patches", () => {
  const db = new Db(":memory:");
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    db.insertTask({
      id: `t${i}`, title: `task ${i}`, prompt: "", repo_path: "", target: "claude", target_state: "suggested",
      base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: null, jira_url: null,
      jira_parent_key: null, pr_url: null, pr_meta: null, status: "open", terminal_address: null, exit_code: null,
      created_ms: now + i, updated_ms: now + i,
    });
  }
  db.updateTask("t0", { status: "dispatched" });
  db.updateTask("t0", { status: "done", branch: "feat/x" });
  db.updateTask("t1", { status: "archived" });

  assert.equal(db.getTask("t0")?.branch, "feat/x");
  assert.equal(db.getTask("t0")?.status, "done");
  assert.equal(db.getTask("t1")?.status, "archived");
  assert.deepEqual(db.listTasks("done").map((t) => t.id), ["t0"]);
  assert.equal(db.listTasks().length, 3);
  db.close();
});
