import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeElicitations } from "../omnigent.ts";
import { CaptureEngine } from "../capture.ts";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import type { WorkerBackend } from "../worker.ts";

const questions = [
  { id: "0", prompt: "Which color?", choices: ["Blue", "Green"], multiple: false },
  { id: "1", prompt: "Which checks?", choices: ["Unit", "Build"], multiple: true },
];

// Shape captured from a live OpenCode question tool call through omnigent.
function pending(batch = false) {
  return [{ elicitation_id: "que-1", type: "response.elicitation_request", params: {
    mode: "form", message: "Color", requestedSchema: null, phase: "pre_tool_use",
    policy_name: "opencode_native_question", content_preview: "Which color?",
    ask_user_question: { questions: (batch ? questions : questions.slice(0, 1)).map((q) => ({
      id: q.id, question: q.prompt, options: q.choices.map((label) => ({ label })), multiSelect: q.multiple,
    })) },
  } }];
}

test("OpenCode questions retain their text, choices, IDs and selection mode", () => {
  assert.deepEqual(normalizeElicitations(pending(true)), [{
    id: "que-1", kind: "question", prompt: "Which color?\n\nWhich checks?",
    choices: [], field: null, questions,
  }]);
  const [single] = normalizeElicitations(pending());
  assert.equal(single.prompt, "Which color?");
  assert.deepEqual(single.choices, ["Blue", "Green"]);
  assert.equal(single.field, "0");
});

test("OpenCode questions survive capture and replies use the structured verdict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-opencode-test-"));
  const db = new Db(join(dir, "test.db"));
  const resolved: unknown[] = [];
  const backend = {
    resolveElicitation: async (...args: unknown[]) => { resolved.push(args); },
    send: async () => { throw new Error("A question answer must not be sent as a message"); },
  } as unknown as WorkerBackend;
  const hub = { broadcast: () => undefined, clients: new Set() };
  const capture = new CaptureEngine(db, backend, hub);
  const server = createHttpServer({ db, backend, capture, hub, cfg: { token: "test" } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const reply = (id: string, body: unknown) => fetch(`http://127.0.0.1:${port}/api/items/${id}/reply`, {
    method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    db.upsertTerminal({ address: "s1", task_id: null, name: null, agent: "opencode", last_status: "working", last_turn: 0, updated_ms: 1 });
    const event = { type: "status" as const, address: "s1", status: "blocked", elicitations: normalizeElicitations(pending()) };
    await capture.handleEvent({ ...event, elicitations: [{ id: "que-1", kind: "question", prompt: "Color", choices: [], field: null }] });
    await capture.handleEvent(event);
    let item = db.openQuestionItemForTerminal("s1")!;
    assert.equal(item.title, "Which color?");
    assert.deepEqual(JSON.parse(item.options!), ["Blue", "Green"]);
    assert.deepEqual(JSON.parse(item.elicitation!).questions, questions.slice(0, 1));
    assert.equal((await reply(item.id, { text: "No, use a custom color" })).status, 200);
    assert.deepEqual(resolved.pop(), ["s1", "que-1", "accept", { "0": "No, use a custom color" }]);

    await capture.handleEvent({ ...event, elicitations: normalizeElicitations(pending(true)) });
    item = db.openQuestionItemForTerminal("s1")!;
    assert.match(item.body, /Which checks/);
    assert.deepEqual(JSON.parse(item.elicitation!).questions, questions);
    for (const content of [{ "0": "Blue" }, { "0": "Blue", "1": [] }, { "0": ["Blue", "Green"], "1": ["Unit"] }]) {
      assert.equal((await reply(item.id, { content })).status, 400);
      assert.equal(db.getItem(item.id)!.status, "open");
      assert.equal(resolved.length, 0);
    }
    assert.equal((await reply(item.id, { content: { "0": "Green", "1": ["Unit", "Build"] } })).status, 200);
    assert.deepEqual(resolved.pop(), ["s1", "que-1", "accept", { "0": "Green", "1": ["Unit", "Build"] }]);
    assert.equal(db.getItem(item.id)!.status, "resolved");
    assert.equal((await reply(item.id, { content: { "0": "Green", "1": ["Unit"] } })).status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
