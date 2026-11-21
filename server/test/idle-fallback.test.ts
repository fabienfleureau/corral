// A run that ends without a report must reach the inbox: the agent prompt
// promises "Corral's fallback capture will pick you up when you go idle".
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { CaptureEngine } from "../capture.ts";
import { OmnigentBackend } from "../omnigent.ts";
import type { Task } from "../types.ts";
import type { WorkerBackend, WorkerEvent, WorkerRunOutcome } from "../worker.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1",
    title: "Add caching",
    prompt: "Add caching",
    repo_path: "/tmp/repo",
    target: "claude",
    target_state: "suggested",
    base_branch: null,
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    pr_url: null,
    pr_meta: null,
    status: "dispatched",
    terminal_address: "s1",
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    ...over,
  };
}

function setup(outcome: WorkerRunOutcome | null, task: Partial<Task> = {}, lastStatus: string | null = "working") {
  const db = new Db(":memory:");
  db.insertTask(makeTask(task));
  db.upsertTerminal({ address: "s1", task_id: "task-1", name: null, agent: "claude", last_status: lastStatus, last_turn: 0, updated_ms: Date.now() });
  let calls = 0;
  let current = outcome;
  const hooks: { fail: boolean; gate: Promise<void> | null } = { fail: false, gate: null };
  const sent: string[] = [];
  const backend = {
    name: "fake",
    read: async () => "tail",
    send: async (_a: string, text: string) => { sent.push(text); },
    lastRunOutcome: async () => {
      calls++;
      if (hooks.gate) await hooks.gate;
      if (hooks.fail) throw new Error("omnigent unreachable");
      return current;
    },
  } as unknown as WorkerBackend;
  const capture = new CaptureEngine(db, backend, { broadcast() {} });
  const status = (s: string, type: WorkerEvent["type"] = "status") => capture.handleEvent({ type, address: "s1", task_id: "task-1", status: s });
  return { db, capture, status, hooks, calls: () => calls, sent, set: (o: WorkerRunOutcome | null) => { current = o; } };
}

const said: WorkerRunOutcome = { kind: "message", text: "Committed locally, but the push was refused." };

test("a completion report resolves open questions from an earlier session for the same task", async () => {
  const { db, capture } = setup(said, { terminal_address: "s2" });
  try {
    const oldQuestion = await capture.createStructuredQuestion({
      kind: "question", taskId: "task-1", terminal: "s1", title: "Old session question", body: "Still open?",
    });
    const done = await capture.createStructuredQuestion({
      kind: "done", taskId: "task-1", terminal: "s2", title: "PR ready", body: "Finished.",
    });
    assert.equal(done.kind, "pr");
    assert.equal(db.getItem(oldQuestion.id)?.status, "resolved");
  } finally { db.close(); }
});

test("a structured question reuses an open question for the same task across sessions", async () => {
  const { db, capture } = setup(said, { terminal_address: "s2" });
  try {
    const first = await capture.createStructuredQuestion({
      kind: "question", taskId: "task-1", terminal: "s1", title: "First question", body: "Body 1",
    });
    const second = await capture.createStructuredQuestion({
      kind: "question", taskId: "task-1", terminal: "s2", title: "Updated question", body: "Body 2",
    });
    assert.equal(second.id, first.id);
    assert.equal(second.source_ref, "s2");
    assert.equal(db.listItems({ kind: "question", status: "open" }).length, 1);
  } finally { db.close(); }
});

test("repeated done reports on a no-PR task update the open digest instead of duplicating it", async () => {
  const { db, capture } = setup(said, { kind: "ops" });
  try {
    const first = await capture.createStructuredQuestion({
      kind: "done", taskId: "task-1", terminal: "s1", title: "Ops done", body: "First pass.",
    });
    const second = await capture.createStructuredQuestion({
      kind: "done", taskId: "task-1", terminal: "s1", title: "Ops done (updated)", body: "Second pass.",
    });
    assert.equal(first.kind, "digest");
    assert.equal(second.id, first.id);
    assert.equal(second.body, "Second pass.");
    assert.equal(db.listItems({ kind: "digest", status: "open" }).length, 1);
  } finally { db.close(); }
});

test("a completion report resolves an earlier stopped-run question", async () => {
  const { db, status, capture } = setup(said);
  try {
    await status("idle");
    const fallback = db.openQuestionItemForTerminal("s1");
    assert.ok(fallback);
    const report = await capture.createStructuredQuestion({ kind: "done", taskId: "task-1", title: "PR ready", body: "Finished." });
    assert.equal(report.kind, "pr");
    assert.equal(db.getItem(fallback.id)?.status, "resolved");
    assert.equal(db.getTask("task-1")?.status, "done");
  } finally { db.close(); }
});

test("a structured report during a permission prompt survives the blocked-to-idle transition", async () => {
  const { db, capture, status } = setup(said);
  try {
    await capture.handleEvent({
      type: "status", address: "s1", task_id: "task-1", status: "blocked",
      elicitations: [{ id: "perm-1", kind: "permission", prompt: "Allow curl?", choices: ["session"] }],
    });
    const elicitationItem = db.openQuestionItemForTerminal("s1");
    assert.ok(elicitationItem, "the permission prompt opens an item");

    const report = await capture.createStructuredQuestion({
      taskId: "task-1", terminal: "s1", kind: "question", title: "Need a decision", body: "Which option?",
    });
    assert.equal(report.id, elicitationItem.id, "the report supersedes the permission item");
    assert.equal(report.structured, 1);

    await status("idle");
    const item = db.openQuestionItemForTerminal("s1");
    assert.equal(item?.id, report.id, "leaving blocked must not resolve the fresh report");
    assert.equal(item?.title, "Need a decision");
    assert.equal(item?.structured, 1);
    assert.doesNotMatch(item!.body, /stopped without reporting/);
  } finally { db.close(); }
});

test("leaving blocked resolves an unanswered elicitation capture", async () => {
  const { db, capture } = setup(said);
  try {
    await capture.handleEvent({
      type: "status", address: "s1", task_id: "task-1", status: "blocked",
      elicitations: [{ id: "perm-1", kind: "permission", prompt: "Allow curl?", choices: ["session"] }],
    });
    const item = db.openQuestionItemForTerminal("s1");
    assert.ok(item?.elicitation, "the permission prompt is captured");
    await capture.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "working" });
    assert.equal(db.getItem(item.id)?.status, "resolved", "the answered prompt closes when the block ends");
  } finally { db.close(); }
});

test("leaving blocked still replaces a captured fallback with the stopped-run report", async () => {
  const { db, capture, status } = setup(said);
  try {
    await capture.handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "blocked" });
    const captured = db.openQuestionItemForTerminal("s1");
    assert.ok(captured);
    assert.equal(captured.structured, 0);
    await status("idle");
    const item = db.openQuestionItemForTerminal("s1");
    assert.equal(item?.id, captured.id);
    assert.match(item!.body, /stopped without reporting/);
  } finally { db.close(); }
});

test("a run that ends in a plain message without a report opens an inbox question", async () => {
  const { db, status } = setup(said);
  try {
    await status("idle");
    const item = db.openQuestionItemForTerminal("s1");
    assert.ok(item, "an item is created");
    assert.equal(item.structured, 0);
    assert.equal(item.task_id, "task-1");
    assert.match(item.body, /push was refused/);
    assert.equal(db.getTask("task-1")!.status, "dispatched", "the task is not closed on the agent's behalf");
  } finally { db.close(); }
});

test("a run that died on an error surfaces the error text", async () => {
  const { db, status } = setup({ kind: "error", text: "Pi model error: 402: Insufficient balance" });
  try {
    await status("idle");
    const item = db.openQuestionItemForTerminal("s1");
    assert.ok(item);
    assert.match(item.title, /failed|error/i);
    assert.match(item.body, /Insufficient balance/);
  } finally { db.close(); }
});

test("repeated idle polls do not read the session again or duplicate the item", async () => {
  const { db, status, calls } = setup(said);
  try {
    await status("idle");
    await status("idle");
    await status("idle");
    assert.equal(calls(), 1);
    const rows = db.raw.prepare("SELECT COUNT(*) AS n FROM items WHERE source_ref = 's1'").get() as { n: number };
    assert.equal(rows.n, 1);
  } finally { db.close(); }
});

test("a human reply that is followed by another silent run reopens the same item", async () => {
  const { db, status, set } = setup(said);
  try {
    await status("idle");
    const first = db.openQuestionItemForTerminal("s1")!;
    db.updateItem(first.id, { status: "resolved", resolved_ms: Date.now() }); // the human replied
    await status("working");
    set({ kind: "message", text: "Pushed it, here is the PR link." });
    await status("idle");
    const again = db.openQuestionItemForTerminal("s1");
    assert.equal(again?.id, first.id);
    assert.match(again!.body, /push was refused/);
    assert.match(again!.body, /here is the PR link/);
  } finally { db.close(); }
});

test("a failed read of the session is retried on the next idle poll", async () => {
  const { db, status, hooks, calls } = setup(said);
  try {
    hooks.fail = true;
    await status("idle");
    assert.equal(db.openQuestionItemForTerminal("s1"), null);
    hooks.fail = false;
    await status("idle");
    assert.ok(db.openQuestionItemForTerminal("s1"), "one transient failure must not hide the stop for good");
    await status("idle");
    assert.equal(calls(), 2, "and a success ends the retrying");
  } finally { db.close(); }
});

test("a run that resumes while the session is being read leaves no stale item", async () => {
  const { db, status, hooks } = setup(said);
  try {
    let release!: () => void;
    hooks.gate = new Promise<void>((resolve) => { release = resolve; });
    const idle = status("idle"); // parked on the read
    await status("working");
    release();
    await idle;
    assert.equal(db.openQuestionItemForTerminal("s1"), null, "the agent is running again");
  } finally { db.close(); }
});

test("nothing is created when the agent already reported, or the task is not in flight", async () => {
  for (const [label, task] of [["done", { status: "done" }], ["archived", { status: "archived" }], ["other session", { terminal_address: "s2" }]] as const) {
    const { db, status } = setup(said, task);
    try {
      await status("idle");
      assert.equal(db.openQuestionItemForTerminal("s1"), null, label);
    } finally { db.close(); }
  }
  const { db, status, calls, capture } = setup(said);
  try {
    await capture.createStructuredQuestion({ taskId: "task-1", terminal: "s1", title: "Use SQLite?", body: "I recommend it." });
    await status("idle");
    assert.equal(calls(), 0, "an open question already asks the human");
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM items WHERE source_ref = 's1'").get()!.n, 1);
  } finally { db.close(); }
});

test("nothing is created when the last thing in the session is not the agent's", async () => {
  const { db, status } = setup(null);
  try {
    await status("idle");
    assert.equal(db.openQuestionItemForTerminal("s1"), null);
  } finally { db.close(); }
});

test("first sight after a restart picks up a stuck task once, and leaves a handled one alone", async () => {
  const stuck = setup(said, {}, "idle");
  try {
    await stuck.status("idle", "created");
    assert.ok(stuck.db.openQuestionItemForTerminal("s1"), "the backlog is surfaced without a migration");
  } finally { stuck.db.close(); }

  const handled = setup(said, {}, "idle");
  try {
    await handled.status("idle");
    const item = handled.db.questionItemForTerminal("s1");
    assert.equal(item, null, "an idle poll alone is not a run end");
    handled.db.insertItem({
      id: "old", kind: "question", status: "resolved", title: "old", summary: "", body: "old", context: "", options: null, ready: 1,
      source_ref: "s1", task_id: "task-1", structured: 0, created_ms: 1, updated_ms: 1, resolved_ms: 2, snooze_until_ms: null,
    });
    await handled.status("idle", "created");
    assert.equal(handled.db.openQuestionItemForTerminal("s1"), null, "a dismissed item does not come back on every restart");
  } finally { handled.db.close(); }
});

test("a run that failed to start is retried, not reported", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask());
    db.upsertTerminal({ address: "s1", task_id: "task-1", name: null, agent: "claude", last_status: "working", last_turn: 0, updated_ms: Date.now() });
    const sent: string[] = [];
    const failure: WorkerRunOutcome = { kind: "error", text: "native_terminal_start_failed" };
    const backend = {
      name: "fake", read: async () => "tail", send: async (_a: string, text: string) => { sent.push(text); },
      initialFailurePrompt: async () => "original prompt",
      lastRunOutcome: async () => failure,
    } as unknown as WorkerBackend;
    const engine = new CaptureEngine(db, backend, { broadcast() {} });
    const idle = { type: "status" as const, address: "s1", task_id: "task-1", status: "idle" };
    await engine.handleEvent(idle);
    assert.deepEqual(sent, ["original prompt"]);
    assert.equal(db.openQuestionItemForTerminal("s1"), null, "the retry is the answer, not an inbox item");
    // The retry runs and fails again: that second end is reported.
    await engine.handleEvent({ ...idle, status: "working" });
    await engine.handleEvent(idle);
    assert.deepEqual(sent, ["original prompt"], "one retry only");
    assert.match(db.openQuestionItemForTerminal("s1")?.body ?? "", /native_terminal_start_failed/);
  } finally { db.close(); }
});

test("a failing start-failure lookup does not hide the stopped run", async () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask());
    db.upsertTerminal({ address: "s1", task_id: "task-1", name: null, agent: "claude", last_status: "working", last_turn: 0, updated_ms: Date.now() });
    const backend = {
      name: "fake", read: async () => "tail", send: async () => undefined,
      initialFailurePrompt: async () => { throw new Error("omnigent unreachable"); },
      lastRunOutcome: async () => said,
    } as unknown as WorkerBackend;
    await new CaptureEngine(db, backend, { broadcast() {} }).handleEvent({ type: "status", address: "s1", task_id: "task-1", status: "idle" });
    assert.ok(db.openQuestionItemForTerminal("s1"));
  } finally { db.close(); }
});

function omnigent(items: unknown[]) {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  const seen: string[] = [];
  (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, path) => { seen.push(path); return { data: items }; };
  return { backend, seen };
}

test("omnigent reports how the last run ended, newest item first", async () => {
  const msg = (role: string, text: string) => ({ type: "message", role, content: [{ type: "output_text", text }] });
  assert.deepEqual(await omnigent([{ type: "resource_event" }, msg("assistant", "All done.")]).backend.lastRunOutcome("s"), { kind: "message", text: "All done." });
  assert.deepEqual(await omnigent([{ type: "error", code: "RuntimeError", message: "Pi model error: 402" }, msg("assistant", "older")]).backend.lastRunOutcome("s"), { kind: "error", text: "Pi model error: 402" });
  assert.equal(await omnigent([msg("user", "do it")]).backend.lastRunOutcome("s"), null);
  assert.equal(await omnigent([{ type: "function_call_output", output: "x" }]).backend.lastRunOutcome("s"), null);
  assert.equal(await omnigent([]).backend.lastRunOutcome("s"), null);
  const { backend, seen } = omnigent([msg("assistant", "x")]);
  await backend.lastRunOutcome("abc");
  assert.match(seen[0], /\/v1\/sessions\/abc\/items\?.*order=desc/);
});
