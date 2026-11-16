import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import type { WorkerBackend } from "../worker.ts";
import type { Task } from "../types.ts";

test("artifact request reaches the Claude task session and records the prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-artifact-"));
  const db = new Db(join(dir, "test.db"));
  const sent: string[][] = [];
  const backend = { send: async (...args: string[]) => { sent.push(args); } } as unknown as WorkerBackend;
  const server = createHttpServer({ db, backend, hub: { broadcast() {} }, cfg: { token: "test" } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const request = (id: string) => fetch(`http://127.0.0.1:${port}/api/tasks/${id}/artifact`, { method: "POST", headers: { Authorization: "Bearer test" } });
  try {
    const now = Date.now();
    db.insertTask({ id: "one", title: "Task", prompt: "Task", kind: "code", repo_path: "/tmp", target: "claude", target_state: "suggested", model: null, reasoning: null, base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null, status: "dispatched", terminal_address: "session", exit_code: null, created_ms: now, updated_ms: now } as Task);
    assert.equal((await request("missing")).status, 404);
    assert.equal((await request("one")).status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], "session");
    assert.match(sent[0][1], /artifact/i);
    assert.ok(db.listTaskEvents("one").some((event) => event.kind === "prompt"));
    db.updateTask("one", { target: "codex" });
    assert.equal((await request("one")).status, 409);
    assert.equal(sent.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
