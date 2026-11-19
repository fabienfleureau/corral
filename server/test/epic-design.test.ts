// Design versions, impacted tasks, amendments and the Jira write-back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { epicContext, applyAmendment, impactedTaskIds, parseAmendments, proposeAmendments, reviseDesign, type DesignJira } from "../epic-design.ts";
import { syncEpic } from "../epic.ts";
import { BlockConflict, type AdfDoc } from "../jira-blocks.ts";
import type { JiraIssue } from "../jira.ts";
import type { Task } from "../types.ts";

const hub = { broadcast: () => undefined };

/** An in-memory Jira: descriptions are ADF documents that writes replace. */
function fakeJira(): DesignJira & { docs: Map<string, unknown>; writes: string[] } {
  const docs = new Map<string, unknown>([["E-1", { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Design v1 text" }] }] }]]);
  const writes: string[] = [];
  const issue = (key: string, summary: string): JiraIssue => ({ key, fields: { summary, description: docs.get(key) ?? null, parent: { key: "E-1" }, status: { name: "To Do" } } });
  return {
    docs, writes,
    getIssue: async (key) => issue(key, key === "E-1" ? "Epic" : `ticket ${key}`),
    epicChildren: async () => [issue("E-2", "first"), issue("E-3", "second")],
    issueToTaskFields: (i) => ({ title: `${i.key} ${i.fields.summary}`, prompt: "ticket text", jira_key: i.key, jira_url: `https://j/${i.key}`, jira_parent_key: "E-1", jira_status: "To Do" }),
    updateDescription: async (key, doc) => { writes.push(key); docs.set(key, doc); },
  };
}

function withEpic(fn: (db: Db, jira: ReturnType<typeof fakeJira>, epicId: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-design-"));
    const db = new Db(join(dir, "t.db"));
    const jira = fakeJira();
    try {
      const { epic } = await syncEpic(db, jira, "E-1");
      await fn(db, jira, epic.id);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

const text = (doc: unknown) => JSON.stringify(doc);

test("import stores design v1 from the epic text", withEpic(async (db, _j, id) => {
  const d = db.latestDesign(id)!;
  assert.equal(d.version, 1);
  assert.equal(d.body, "Design v1 text");
}));

test("a revision writes one block to the epic description, stores v2, and a second revision replaces it", withEpic(async (db, jira, id) => {
  const epic = () => db.getEpic(id)!;
  const v2 = await reviseDesign(db, jira, epic(), { body: "Use REST", reason: "switch" });
  assert.equal(v2.version, 2);
  assert.ok(text(jira.docs.get("E-1")).includes("Design v1 text"), "the human's text survives");
  assert.ok(text(jira.docs.get("E-1")).includes("Use REST"));
  const v3 = await reviseDesign(db, jira, epic(), { body: "Use gRPC", reason: "again" });
  assert.equal(v3.version, 3);
  const t = text(jira.docs.get("E-1"));
  assert.ok(t.includes("Use gRPC") && !t.includes("Use REST"), "only the current version is in Jira");
  assert.equal(db.listDesigns(id).length, 3);
  await syncEpic(db, jira, "E-1");
  assert.equal(db.getEpic(id)!.description, "Design v1 text", "a resync does not fold the block into the epic text");
}));

test("a block edited in Jira stops the revision and nothing is saved", withEpic(async (db, jira, id) => {
  await reviseDesign(db, jira, db.getEpic(id)!, { body: "A", reason: "" });
  const doc = jira.docs.get("E-1") as AdfDoc;
  const at = doc.content.findIndex((n) => n.content?.[0]?.text === "[corral:begin:design]");
  doc.content[at + 1].content![0].text = "hand edit";
  await assert.rejects(reviseDesign(db, jira, db.getEpic(id)!, { body: "B", reason: "" }), BlockConflict);
  assert.equal(db.listDesigns(id).length, 2);
}));

test("impacted: started, unmerged tasks on an older design; unstarted and merged are not", withEpic(async (db, jira, id) => {
  const [a, b] = db.listEpicTasks(id);
  db.updateTask(a.id, { status: "dispatched", terminal_address: "s", design_version: 1 });
  await reviseDesign(db, jira, db.getEpic(id)!, { body: "new", reason: "" });
  assert.deepEqual([...impactedTaskIds(db, id)], [a.id]);
  db.updateTask(a.id, { jira_status: "Killed" });
  assert.equal(impactedTaskIds(db, id).size, 0, "a killed ticket is no longer in flight");
  db.updateTask(a.id, { status: "done", jira_status: "Done" });
  assert.equal(impactedTaskIds(db, id).size, 0);
  assert.equal(db.getTask(b.id)!.status, "open");
}));

test("amendment replies: only known keys with text are kept", () => {
  const keys = new Set(["E-2", "E-3"]);
  assert.deepEqual(parseAmendments('Sure: [{"key":"E-2","amendment":" Use REST "},{"key":"X-9","amendment":"no"},{"key":"E-3","amendment":""}]', keys), [{ key: "E-2", amendment: "Use REST" }]);
  assert.deepEqual(parseAmendments("not json", keys), []);
  assert.deepEqual(parseAmendments("[]", keys), []);
});

test("proposals reach the inbox for unstarted tasks only; apply writes the ticket block, task and item", withEpic(async (db, jira, id) => {
  const [started, open] = db.listEpicTasks(id);
  db.updateTask(started.id, { status: "dispatched", terminal_address: "s", design_version: 1 });
  const design = await reviseDesign(db, jira, db.getEpic(id)!, { body: "Use REST", reason: "switch" });
  let prompt = "";
  const made = await proposeAmendments(db, hub, db.getEpic(id)!, design.version, "switch", "FRAME", async (p) => {
    prompt = p;
    return JSON.stringify([{ key: started.jira_key, amendment: "ignored: started" }, { key: open.jira_key, amendment: "Call the REST endpoint" }]);
  });
  assert.match(prompt, /FRAME/);
  assert.ok(!prompt.includes(`task ${started.jira_key} ---`), "a started task is not asked about");
  assert.equal(made.length, 1);
  assert.equal(db.listItems({ kind: "amendment" }).length, 1);
  assert.equal(jira.writes.filter((k) => k === open.jira_key).length, 0, "nothing written to the ticket yet");

  await applyAmendment(db, hub, jira, made[0]);
  const task = db.getTask(open.id)!;
  assert.equal(task.amendment, "Call the REST endpoint");
  assert.ok(text(jira.docs.get(open.jira_key!)).includes("Call the REST endpoint"));
  assert.equal(db.getAmendment(made[0].id)!.status, "applied");
  assert.equal(db.listItems({ kind: "amendment" })[0].status, "resolved");
  assert.match(epicContext(db, task), /Epic design \(v2\)[\s\S]*Use REST[\s\S]*Amendment to this task[\s\S]*Call the REST endpoint/);
}));

test("a newer proposal replaces one still waiting for the same task", withEpic(async (db, jira, id) => {
  const open = db.listEpicTasks(id)[1];
  const reply = (s: string) => async () => JSON.stringify([{ key: open.jira_key, amendment: s }]);
  const v2 = await reviseDesign(db, jira, db.getEpic(id)!, { body: "A", reason: "" });
  await proposeAmendments(db, hub, db.getEpic(id)!, v2.version, "", "F", reply("first"));
  const v3 = await reviseDesign(db, jira, db.getEpic(id)!, { body: "B", reason: "" });
  await proposeAmendments(db, hub, db.getEpic(id)!, v3.version, "", "F", reply("second"));
  assert.deepEqual(db.listAmendments(id, "proposed").map((a) => a.body), ["second"]);
}));

test("an imported design is context, not 'what the human agreed'; a human revision is", withEpic(async (db, jira, id) => {
  const task = db.listEpicTasks(id)[0];
  assert.match(epicContext(db, task), /Epic design \(v1\)[\s\S]*not instructions/);
  assert.doesNotMatch(epicContext(db, task), /human agreed/);
  await reviseDesign(db, jira, db.getEpic(id)!, { body: "Use REST", reason: "" });
  assert.match(epicContext(db, task), /Epic design \(v2\)[\s\S]*the human agreed/);
}));

test("epicContext is empty outside an epic", () => {
  assert.equal(epicContext({ latestDesign: () => null } as unknown as Db, { epic_id: null } as Task), "");
});
