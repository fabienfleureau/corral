// Epic import and sync: Jira links to dependencies, repo from the ticket, cycles,
// tickets leaving the epic, and work that already started staying untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { blockedByEdges, type JiraIssue } from "../jira.ts";
import { findCycle, isJiraDone, parseRepoLine, syncEpic, type EpicJira } from "../epic.ts";
import type { Repo, Task } from "../types.ts";

const issue = (key: string, summary: string, description = "", links: JiraIssue["fields"]["issuelinks"] = [], status = "To Do"): JiraIssue => ({
  key, fields: { summary, description, status: { name: status }, issuelinks: links, parent: { key: "E-1" } },
});
const blockedBy = (key: string) => ({ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key } });
const blocks = (key: string) => ({ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key } });

function fakeJira(epic: JiraIssue, children: JiraIssue[]): EpicJira & { children: JiraIssue[] } {
  const self = {
    children,
    getIssue: async () => epic,
    epicChildren: async () => self.children,
    issueToTaskFields: (i: JiraIssue) => ({
      title: `${i.key} ${i.fields.summary}`, prompt: String(i.fields.description ?? ""), jira_key: i.key,
      jira_url: `https://j/browse/${i.key}`, jira_parent_key: i.fields.parent?.key ?? null, jira_status: i.fields.status?.name ?? null,
    }),
  };
  return self;
}

function withDb(fn: (db: Db) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-epic-"));
    const db = new Db(join(dir, "t.db"));
    try { await fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

const repo = (name: string, path: string): Repo => ({ id: name, name, path, jira_prefix: null, context: null, source: "manual", created_ms: 0 });

test("links: 'blocked by' on one side and 'blocks' on the other give one edge, outside the epic ignored", () => {
  const edges = blockedByEdges([
    issue("A-2", "b", "", [blockedBy("A-1"), blockedBy("OUT-9")]),
    issue("A-1", "a", "", [blocks("A-2")]),
  ]);
  assert.deepEqual(edges, [{ task_key: "A-2", blocked_by_key: "A-1" }]);
});

test("links: direction matters — 'blocks' alone does not block the issue that carries it", () => {
  assert.deepEqual(blockedByEdges([issue("A-1", "a", "", [blocks("A-2")]), issue("A-2", "b")]), [{ task_key: "A-2", blocked_by_key: "A-1" }]);
});

test("repo line: matches name, folder or path, case-insensitively; unknown stays unset", () => {
  const repos = [repo("Engine", "/w/engine"), repo("api", "/w/rust-backend")];
  assert.equal(parseRepoLine("Goal\nRepo: engine\nmore", repos)?.path, "/w/engine");
  assert.equal(parseRepoLine("repo: `rust-backend`", repos)?.path, "/w/rust-backend");
  assert.equal(parseRepoLine("Repo: nothing", repos), null);
  assert.equal(parseRepoLine("no line", repos), null);
});

test("cycle: detected, acyclic graph is fine", () => {
  assert.deepEqual(findCycle([{ task_key: "A", blocked_by_key: "B" }, { task_key: "B", blocked_by_key: "A" }])?.slice(0, 2).sort(), ["A", "B"]);
  assert.equal(findCycle([{ task_key: "B", blocked_by_key: "A" }, { task_key: "C", blocked_by_key: "A" }]), null);
});

test("jira done statuses", () => {
  assert.equal(isJiraDone("Done"), true);
  assert.equal(isJiraDone("Terminé"), true);
  assert.equal(isJiraDone("In Progress"), false);
});

test("sync: imports children as tasks with links, repo and no duplicates on resync", withDb(async (db) => {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-repo-"));
  db.insertRepo(repo("engine", dir));
  const jira = fakeJira(issue("E-1", "Big change", "Design v1"), [
    issue("E-2", "first", "Repo: engine\nDo it"),
    issue("E-3", "second", "Repo: engine", [blockedBy("E-2")]),
  ]);
  const first = await syncEpic(db, jira, "E-1");
  assert.deepEqual(first.created, ["E-2", "E-3"]);
  assert.equal(first.epic.description, "Design v1");
  const tasks = db.listEpicTasks(first.epic.id);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].repo_path, dir);
  assert.deepEqual(db.listEpicLinks(first.epic.id).map((l) => [l.task_key, l.blocked_by_key]), [["E-3", "E-2"]]);
  const again = await syncEpic(db, jira, "E-1");
  assert.deepEqual(again.created, []);
  assert.equal(db.listEpicTasks(first.epic.id).length, 2);
  assert.equal(db.listEpics().length, 1);
  rmSync(dir, { recursive: true, force: true });
}));

test("sync: Jira edits reach an unstarted task, never a dispatched one", withDb(async (db) => {
  const jira = fakeJira(issue("E-1", "Epic"), [issue("E-2", "first", "old"), issue("E-3", "second", "old")]);
  const { epic } = await syncEpic(db, jira, "E-1");
  const started = db.getTaskByJiraKey("E-3")!;
  db.updateTask(started.id, { status: "dispatched", terminal_address: "s1" });
  jira.children = [issue("E-2", "first", "new", [], "In Progress"), issue("E-3", "second", "new")];
  const r = await syncEpic(db, jira, "E-1");
  assert.equal(db.getTaskByJiraKey("E-2")!.prompt, "new");
  assert.equal(db.getTaskByJiraKey("E-2")!.jira_status, "In Progress");
  assert.equal(db.getTaskByJiraKey("E-3")!.prompt, "old");
  assert.deepEqual(r.updated, ["E-2"]);
  assert.equal(r.epic.id, epic.id);
}));

test("sync: an existing task is attached to the epic instead of duplicated", withDb(async (db) => {
  const now = Date.now();
  const task: Task = { id: "t1", title: "E-2 first", prompt: "mine", repo_path: "/r", target: "", target_state: "suggested", base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: "E-2", jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null, status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now };
  db.insertTask(task);
  const { epic, created } = await syncEpic(db, fakeJira(issue("E-1", "Epic"), [issue("E-2", "first", "from jira")]), "E-1");
  assert.deepEqual(created, []);
  assert.equal(db.getTask("t1")!.prompt, "mine", "a hand-written prompt is not replaced by ticket text");
  assert.equal(db.getTask("t1")!.jira_url, null, "a second sync must still see a hand-written task");
  await syncEpic(db, fakeJira(issue("E-1", "Epic"), [issue("E-2", "first", "from jira again")]), "E-1");
  assert.equal(db.getTask("t1")!.prompt, "mine", "still not replaced after a second sync");
  assert.equal(db.getTask("t1")!.epic_id, epic.id);
  assert.equal(db.listTasks().length, 1);
}));

test("sync: a ticket that left the epic is flagged, and back again is restored; a cycle is reported", withDb(async (db) => {
  const jira = fakeJira(issue("E-1", "Epic"), [issue("E-2", "a"), issue("E-3", "b")]);
  const { epic } = await syncEpic(db, jira, "E-1");
  jira.children = [issue("E-2", "a")];
  const r = await syncEpic(db, jira, "E-1");
  assert.deepEqual(r.out, ["E-3"]);
  assert.equal(db.getTaskByJiraKey("E-3")!.epic_out, 1);
  jira.children = [issue("E-2", "a", "", [blockedBy("E-3")]), issue("E-3", "b", "", [blockedBy("E-2")])];
  const back = await syncEpic(db, jira, "E-1");
  assert.equal(db.getTaskByJiraKey("E-3")!.epic_out, 0);
  assert.match(back.epic.error ?? "", /cycle/i);
  assert.equal(db.getEpic(epic.id)!.error, back.epic.error);
}));
