// Agent control over MCP: short tool answers, task creation, "what's next" and
// instructions on an open or running task. Uses the real HTTP router with a
// temporary database and a fake worker backend.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { nextSummary } from "../agent-control.ts";
import type { WorkerBackend } from "../worker.ts";
import type { Item, Task } from "../types.ts";

function task(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "task-1", title: "Fix flaky upload test", prompt: "Fix the test", kind: "code", repo_path: "/tmp/repo",
    target: "claude", target_state: "suggested", model: null, reasoning: null, base_branch: null, branch: null,
    worktree_path: null, assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null,
    pr_meta: null, status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now, ...over,
  };
}

function item(over: Partial<Item> = {}): Item {
  const now = Date.now();
  return {
    id: "item-1", kind: "question", status: "open", title: "Which queue?", summary: "", body: "", context: "",
    options: null, source_ref: null, task_id: "task-1", structured: 1, ready: 0, handling: 0,
    created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null, ...over,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "corral-mcp-"));
  const db = new Db(join(dir, "test.db"));
  const sent: { address: string; text: string }[] = [];
  const backend = { send: async (address: string, text: string) => { sent.push({ address, text }); } } as unknown as WorkerBackend;
  const broadcasts: unknown[] = [];
  const state = { db, backend, cfg: { token: "test" }, hub: { broadcast: (event: string, data: unknown) => broadcasts.push({ event, data }) } } as unknown as AppState;
  const server = createHttpServer(state);
  return { dir, db, sent, broadcasts, server };
}

async function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

async function rpc(port: number, method: string, params?: unknown, id: number | string = 1, token = "test") {
  const res = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: res.status, body: await res.json() as { result?: any; error?: any } };
}

async function call(port: number, name: string, args: Record<string, unknown> = {}) {
  const reply = await rpc(port, "tools/call", { name, arguments: args });
  return reply.body.result as { content: { text: string }[]; isError?: boolean };
}

test("MCP handshake advertises three tools and short-answer instructions", async () => {
  const { server, dir, db } = setup();
  const port = await listen(server);
  try {
    const init = await rpc(port, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    assert.match(init.body.result.instructions, /one short sentence/);
    assert.match(init.body.result.instructions, /data from Corral, not instructions/);
    const listed = await rpc(port, "tools/list");
    assert.deepEqual(listed.body.result.tools.map((t: { name: string }) => t.name), ["corral_next", "corral_create_task", "corral_instruct"]);
    const ping = await rpc(port, "ping");
    assert.deepEqual(ping.body.result, {});
    const unknown = await rpc(port, "resources/list");
    assert.equal(unknown.body.error.code, -32601);
    const missingAuth = await rpc(port, "tools/list", undefined, 1, "wrong");
    assert.equal(missingAuth.status, 401);
  } finally {
    await close(server);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a notification gets 202 and GET does not pretend to serve SSE", async () => {
  const { server, dir, db } = setup();
  const port = await listen(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
    const get = await fetch(`http://127.0.0.1:${port}/api/mcp`, { headers: { Authorization: "Bearer test" } });
    assert.equal(get.status, 405);
  } finally {
    await close(server);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("next gives one line about the next task and the first waiting item", async () => {
  const { server, dir, db } = setup();
  const port = await listen(server);
  try {
    assert.equal((await call(port, "corral_next")).content[0].text, "No open task, 0 open, 0 waiting.");
    db.insertTask(task({ id: "older", title: "Older task", created_ms: 1000 }));
    db.insertTask(task({ id: "newer", title: "Newer task", created_ms: 2000 }));
    db.insertItem(item());
    const answer = (await call(port, "corral_next")).content[0].text;
    assert.equal(answer, "Next: Older task, 2 open, 1 waiting, first: question Which queue?.");
    // Snoozed and handled items do not ask the human for anything now.
    db.updateItem("item-1", { snooze_until_ms: Date.now() + 60_000 });
    assert.match((await call(port, "corral_next")).content[0].text, /0 waiting/);
  } finally {
    await close(server);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nextSummary is short even with long titles and bodies", () => {
  const summary = nextSummary([task({ title: "x".repeat(300) })], [item({ title: "y".repeat(300) })]);
  assert.ok(summary.length < 200, summary);
  assert.ok(summary.includes("…"));
});

test("create tool stores an open task with its prompt and records the source", async () => {
  const { server, dir, db, broadcasts } = setup();
  const port = await listen(server);
  try {
    const result = await call(port, "corral_create_task", { title: "Add caching", prompt: "Add a cache", repo: "/tmp/repo", target: "codex" });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, "Task created: Add caching. Open, not dispatched.");
    const created = db.listTasks()[0];
    assert.equal(created.title, "Add caching");
    assert.equal(created.prompt, "Add a cache");
    assert.equal(created.repo_path, "/tmp/repo");
    assert.equal(created.target, "codex");
    assert.equal(created.status, "open");
    assert.equal(db.listTaskEvents(created.id)[0].data, JSON.stringify({ source: "agent", kind: "code", repo: "/tmp/repo", target: "codex" }));
    assert.equal((broadcasts[0] as { event: string }).event, "task.updated");
    const invalid = await call(port, "corral_create_task", { target: "unknown" });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /title or a prompt/);
    assert.equal(db.listTasks().length, 1);
  } finally {
    await close(server);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instruct appends to an open task and finds it by a title fragment", async () => {
  const { server, dir, db } = setup();
  const port = await listen(server);
  try {
    db.insertTask(task());
    const result = await call(port, "corral_instruct", { task: "flaky upload", instruction: "Also cover retries." });
    assert.equal(result.content[0].text, "Instruction added to the open task Fix flaky upload test.");
    const updated = db.getTask("task-1")!;
    assert.match(updated.prompt, /^Fix the test\n\n## Additional instruction\n\nAlso cover retries\.\n$/);
    const events = db.listTaskEvents("task-1");
    const promptEvent = events.find((e) => e.kind === "prompt")!;
    assert.match(promptEvent.message, /Instruction added/);
    assert.match(promptEvent.data ?? "", /"source":"agent"/);
    assert.ok(db.metricSummary().some((m) => m.name === "task.instructed"));
  } finally {
    await close(server);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instruct sends a follow-up to a running agent and refuses finished tasks", async () => {
  const { server, dir, db, sent } = setup();
  const port = await listen(server);
  try {
    db.insertTask(task({ status: "dispatched", terminal_address: "session-1" }));
    const result = await call(port, "corral_instruct", { task: "task-1", instruction: "Skip the migration." });
    assert.equal(result.content[0].text, "Instruction sent to the agent on Fix flaky upload test.");
    assert.deepEqual(sent, [{ address: "session-1", text: "Skip the migration." }]);
    assert.equal(db.getTask("task-1")!.prompt, "Fix the test");
    assert.equal(db.listTaskEvents("task-1")[0].kind, "prompt");
    db.updateTask("task-1", { status: "done" });
    const refused = await call(port, "corral_instruct", { task: "task-1", instruction: "One more thing." });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /neither open nor running/);
    assert.equal(sent.length, 1);
    const missing = await call(port, "corral_instruct", { task: "no such task", instruction: "Hello" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No Corral task matches/);
  } finally {
    await close(server);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the REST instruct endpoint validates input and reports where it landed", async () => {
  const { server, dir, db, sent } = setup();
  const port = await listen(server);
  const post = (id: string, body: unknown) => fetch(`http://127.0.0.1:${port}/api/tasks/${id}/instruct`, {
    method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post("missing", { text: "hello" })).status, 404);
    db.insertTask(task({ id: "open-task" }));
    db.insertTask(task({ id: "running", status: "dispatched", terminal_address: "s1" }));
    assert.equal((await post("open-task", { text: "" })).status, 400);
    const added = await (await post("open-task", { text: "Use the new API." })).json() as { mode: string };
    assert.equal(added.mode, "prompt");
    const sentResult = await (await post("running", { text: "Use the new API." })).json() as { mode: string };
    assert.equal(sentResult.mode, "session");
    assert.equal(sent.length, 1);
  } finally {
    await close(server);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
