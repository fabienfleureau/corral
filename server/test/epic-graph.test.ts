// Epic readiness: what is blocked, what is ready to launch, what stacks on what.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { archiveEpicLaunchItems, epicSummary, epicViews, stackEpicTaskOnPrerequisite } from "../epic-graph.ts";
import type { EpicLink, EpicTicket, Item, Task } from "../types.ts";

const task = (key: string, over: Partial<Task> = {}): Task => ({
  id: key, title: `${key} t`, prompt: "", repo_path: "/r/a", target: "", target_state: "suggested", base_branch: null, branch: null,
  worktree_path: null, assignee: null, jira_key: key, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null, status: "open",
  terminal_address: null, exit_code: null, created_ms: 1, updated_ms: 1, epic_id: "e", epic_out: 0, ...over,
});
const link = (t: string, b: string): EpicLink => ({ epic_id: "e", task_key: t, blocked_by_key: b });
const pr = (taskId: string, over: Partial<Item> = {}): Item => ({
  id: `pr-${taskId}`, kind: "pr", status: "open", title: "", summary: "", body: "", context: "", options: null, ready: 0, handling: 0,
  source_ref: null, task_id: taskId, structured: 1, created_ms: 1, updated_ms: 1, resolved_ms: null, snooze_until_ms: null, ...over,
});
const state = (views: ReturnType<typeof epicViews>, key: string) => views.find((v) => v.task.jira_key === key)!;

test("a task is blocked until its prerequisite PR is green and ready, then ready to launch", () => {
  const tasks = [task("A-1", { status: "dispatched", branch: "a1", pr_url: "u" }), task("A-2")];
  const links = [link("A-2", "A-1")];
  assert.equal(state(epicViews(tasks, links, [pr("A-1", { ready: 0 })]), "A-2").state, "blocked");
  const ready = epicViews(tasks, links, [pr("A-1", { ready: 1 })]);
  assert.equal(state(ready, "A-2").state, "ready");
  assert.equal(state(ready, "A-1").state, "pr_ready");
});

test("merged or Jira-done prerequisite unblocks; a ticket that left the epic is ignored", () => {
  const links = [link("A-2", "A-1"), link("A-2", "A-0")];
  const merged = epicViews([task("A-0", { status: "done" }), task("A-1", { jira_status: "Done" }), task("A-2")], links, []);
  assert.equal(state(merged, "A-2").state, "ready");
  const out = epicViews([task("A-1", { epic_out: 1 }), task("A-2")], [link("A-2", "A-1")], []);
  assert.equal(state(out, "A-2").state, "ready");
  assert.equal(state(out, "A-1").state, "out");
});

test("a Jira Killed ticket is terminal: shown as killed, no launch or stacking, and no longer blocks", () => {
  const killed = task("A-1", { jira_status: "Killed", status: "dispatched", terminal_address: "s", branch: "feat/a1", pr_url: "u" });
  const views = epicViews([killed, task("A-2")], [link("A-2", "A-1")], [pr("A-1", { ready: 1 })]);
  assert.equal(state(views, "A-1").state, "killed", "Jira wins over a green PR");
  assert.equal(state(views, "A-1").testable, false);
  assert.equal(state(views, "A-2").state, "ready");
  assert.equal(state(views, "A-2").stack_on, null, "never stack on a cancelled branch");
  assert.deepEqual(epicSummary(views), { total: 1, merged: 0, testable: 0, ready: 1, blocked: 0 });
});

test("a killed prerequisite stays visible as a note on its dependents", () => {
  const views = epicViews([task("A-1", { jira_status: "killed" }), task("A-2", { jira_status: "To Do" })], [link("A-2", "A-1")], []);
  assert.equal(state(views, "A-2").state, "ready");
  assert.match(state(views, "A-2").alert ?? "", /A-1.*killed/);
});

test("same-repo: stack on the only unmerged prerequisite branch; other repo or several blockers use the default", () => {
  const dep = (over: Partial<Task>) => task("A-1", { status: "dispatched", branch: "feat/a1", pr_url: "u", ...over });
  const ready = [pr("A-1", { ready: 1 })];
  assert.equal(state(epicViews([dep({}), task("A-2")], [link("A-2", "A-1")], ready), "A-2").stack_on, "feat/a1");
  assert.equal(state(epicViews([dep({ repo_path: "/r/b" }), task("A-2")], [link("A-2", "A-1")], ready), "A-2").stack_on, null);
  const two = epicViews([dep({}), task("A-3", { status: "dispatched", branch: "feat/a3", pr_url: "u" }), task("A-2")], [link("A-2", "A-1"), link("A-2", "A-3")], [...ready, pr("A-3", { ready: 1 })]);
  assert.equal(state(two, "A-2").stack_on, null);
  assert.equal(state(epicViews([dep({ status: "done" }), task("A-2")], [link("A-2", "A-1")], []), "A-2").stack_on, null);
});

test("a prerequisite PR closed without merging keeps dependents blocked and raises an alert", () => {
  const views = epicViews([task("A-1", { status: "dispatched", pr_url: "u" }), task("A-2")], [link("A-2", "A-1")], [pr("A-1", { status: "resolved" })]);
  assert.equal(state(views, "A-2").state, "blocked");
  assert.match(state(views, "A-2").alert ?? "", /A-1.*closed/);
});

test("order follows dependencies, summary counts merged and testable", () => {
  const tasks = [task("A-3"), task("A-1", { status: "done" }), task("A-2", { status: "dispatched", pr_url: "u", branch: "b" })];
  const views = epicViews(tasks, [link("A-3", "A-2"), link("A-2", "A-1")], [pr("A-2", { ready: 1 })]);
  assert.deepEqual(views.map((v) => v.task.jira_key), ["A-1", "A-2", "A-3"]);
  assert.deepEqual(epicSummary(views), { total: 3, merged: 1, testable: 2, ready: 1, blocked: 0 });
});

test("the board lists only Jira tickets, not tasks created from a request", () => {
  const jira = task("A-1");
  const request = task("request-1", { jira_key: null, title: "Draft release notes" });
  const views = epicViews([request, jira], [], []);
  assert.deepEqual(views.map((v) => v.task.id), ["A-1"]);
  assert.deepEqual(epicSummary(views), { total: 1, merged: 0, testable: 0, ready: 1, blocked: 0 });
});

test("a dependency cycle does not hang ordering", () => {
  const views = epicViews([task("A-1"), task("A-2")], [link("A-1", "A-2"), link("A-2", "A-1")], []);
  assert.equal(views.length, 2);
});

test("no launch items are created; stale ones archive and stacking waits for the click", () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-g-"));
  const db = new Db(join(dir, "t.db"));
  const hub = { broadcast: () => undefined };
  try {
    db.insertEpic({ id: "e", jira_key: "E-1", title: "E", description: "", error: null, synced_ms: 1, created_ms: 1 });
    db.insertTask(task("A-1", { status: "dispatched", branch: "feat/a1", pr_url: "u", terminal_address: "s" }));
    db.insertTask(task("A-2"));
    db.replaceEpicLinks("e", [{ task_key: "A-2", blocked_by_key: "A-1" }]);
    archiveEpicLaunchItems(db, hub);
    assert.equal(db.listItems({ kind: "launch" }).length, 0);
    db.insertItem(pr("A-1", { ready: 1 }));
    archiveEpicLaunchItems(db, hub);
    archiveEpicLaunchItems(db, hub);
    assert.equal(db.listItems({ kind: "launch" }).length, 0, "ready creates no item");
    assert.equal(db.getTask("A-2")!.base_branch, null, "ready does not edit the task");
    // A launch item saved by an older Corral stays until the click starts the task.
    const legacy = pr("A-2", { id: "old-launch", kind: "launch", title: "Ready to launch: A-2 t" });
    db.insertItem(legacy);
    archiveEpicLaunchItems(db, hub);
    assert.equal(db.getItem(legacy.id)!.status, "open");
    const view = epicViews(db.listEpicTasks("e"), db.listEpicLinks("e"), db.listItems()).find((v) => v.task.id === "A-2")!;
    stackEpicTaskOnPrerequisite(db, hub, view);
    assert.equal(db.getTask("A-2")!.base_branch, "feat/a1");
    db.updateTask("A-2", { status: "dispatched", terminal_address: "s2" });
    archiveEpicLaunchItems(db, hub);
    assert.equal(db.getItem(legacy.id)!.status, "archived");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synced epic_tickets project onto the graph, block dependents, re-surface when archived, and preview stack_on", () => {
  const ticket = (key: string, over: Partial<EpicTicket> = {}): EpicTicket => ({
    epic_id: "e",
    jira_key: key,
    title: `${key} title`,
    description: `${key} desc`,
    jira_url: `https://j/browse/${key}`,
    jira_status: "To Do",
    jira_parent_key: "E-1",
    suggested_repo_path: "",
    updated_ms: 1,
    ...over,
  });

  // Uncreated ticket E-2 is ready; uncreated E-3 blocked by E-2 is blocked;
  // uncreated E-4 blocked by Done E-1 is ready; Killed E-5 is killed and unblocks E-6.
  const views = epicViews(
    [
      task("E-0", { status: "dispatched", branch: "feat/e0", pr_url: "u", repo_path: "/r/a" }),
      // Archived task for E-7 must not suppress the synced ticket E-7.
      task("E-7", { status: "archived" }),
    ],
    [
      link("E-2", "E-0"),
      link("E-3", "E-2"),
      link("E-4", "E-1"),
      link("E-6", "E-5"),
    ],
    [pr("E-0", { ready: 1 })],
    [
      ticket("E-0"),
      ticket("E-1", { jira_status: "Done" }),
      ticket("E-2", { suggested_repo_path: "/r/a" }),
      ticket("E-3"),
      ticket("E-4"),
      ticket("E-5", { jira_status: "Killed" }),
      ticket("E-6"),
      ticket("E-7"),
    ],
  );

  const byKey = new Map(views.map((v) => [v.task.jira_key!, v]));
  assert.equal(byKey.get("E-0")?.has_task, true);
  assert.equal(byKey.get("E-0")?.state, "pr_ready");
  assert.equal(byKey.get("E-1")?.has_task, false);
  assert.equal(byKey.get("E-1")?.state, "merged");
  assert.equal(byKey.get("E-2")?.has_task, false);
  assert.equal(byKey.get("E-2")?.state, "ready");
  assert.equal(byKey.get("E-2")?.stack_on, "feat/e0");
  assert.equal(byKey.get("E-3")?.has_task, false);
  assert.equal(byKey.get("E-3")?.state, "blocked");
  assert.equal(byKey.get("E-3")?.blockers[0]?.satisfied, false);
  assert.equal(byKey.get("E-3")?.blockers[0]?.task_id, null);
  assert.equal(byKey.get("E-4")?.state, "ready");
  assert.equal(byKey.get("E-5")?.state, "killed");
  assert.equal(byKey.get("E-6")?.state, "ready");
  assert.equal(byKey.get("E-7")?.has_task, false);
  assert.equal(byKey.get("E-7")?.state, "ready");
});
