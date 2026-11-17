// The single Epic request field creates a tracked task and keeps the favorite
// and working directory on the epic for the next request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer, type AppState } from "../api.ts";
import type { Config } from "../config.ts";
import { Db } from "../db.ts";
import type { Favorite } from "../favorites.ts";
import type { Reviewer } from "../reviewers.ts";
import type { Epic, Repo, Task } from "../types.ts";
import type { WorkerBackend } from "../worker.ts";

const favorites: Favorite[] = [
  { name: "Work", harness: "claude", agent: "worker", model: "opus", reasoning: "high", context: "professional", review: "cubic" },
  { name: "Home", harness: "codex", agent: "", model: "", reasoning: "", context: "personal", review: "" },
];
const reviewers: Reviewer[] = [{ name: "cubic", command: "cubic review --base {base_branch}" }];
const work: Repo = { id: "work", name: "work", path: "/sample/work", jira_prefix: null, context: null, source: "manual", created_ms: 0 };
const home: Repo = { id: "home", name: "home", path: "/sample/home", jira_prefix: null, context: "personal", source: "manual", created_ms: 0 };

async function withApi(fn: (send: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>, db: Db) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-request-"));
  const db = new Db(":memory:");
  const config = { token: "test", configDir: dir, host: "localhost", port: 4787, favorites, reviewers } as Config;
  const server = createHttpServer({
    db, cfg: config, backend: {} as WorkerBackend, hub: { broadcast() { /* no clients */ } },
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method, headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };
  try {
    const now = Date.now();
    const epic: Epic = { id: "e", jira_key: "E-1", title: "Epic", description: "Design", error: null, synced_ms: now, created_ms: now };
    db.insertEpic(epic);
    db.insertRepo(work);
    db.insertRepo(home);
    await fn(send, db);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("epic request: settings persist and a request becomes a linked task", () => withApi(async (send, db) => {
  const saved = await send("PATCH", "/api/epics/e", { favorite_name: "Work", repo_path: work.path });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.epic.favorite_name, "Work");
  assert.equal(saved.body.epic.repo_path, work.path);

  const created = await send("POST", "/api/epics/e/requests", { request: "Split the widget work\ninto two tickets" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const task = created.body as Task;
  assert.equal(task.epic_id, "e");
  assert.equal(task.prompt, "Split the widget work\ninto two tickets");
  assert.equal(task.title, "Split the widget work");
  assert.equal(task.repo_path, work.path);
  assert.equal(task.target, "claude");
  assert.equal(task.agent, "worker");
  assert.equal(task.model, "opus");
  assert.equal(task.reasoning, "high");
  assert.equal(task.review, reviewers[0].command);
  assert.equal(task.status, "open");
  assert.equal(db.listEpicTasks("e").length, 1, "the task stays on the epic page until launched");
  assert.equal(db.getEpic("e")!.favorite_name, "Work");
  assert.equal(db.getEpic("e")!.repo_path, work.path);

  // Changing one selector keeps the other and the next request uses both.
  const changed = await send("PATCH", "/api/epics/e", { repo_path: home.path });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.epic.favorite_name, null, "an incompatible favorite is cleared, not silently ignored");
  const next = await send("POST", "/api/epics/e/requests", { request: "Personal follow-up", favorite_name: "Home", repo_path: home.path });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body.target, "codex");
  assert.equal(next.body.repo_path, home.path);
  assert.equal(db.getEpic("e")!.favorite_name, "Home");
}));

test("epic request: bad input is refused without leaving a task behind", () => withApi(async (send, db) => {
  for (const body of [
    { request: "" },
    { request: "x".repeat(8001) },
    { request: "do it", favorite_name: "Missing" },
    { request: "do it", favorite_name: "Work", repo_path: home.path },
    { request: "do it", favorite_name: "Home", repo_path: "/some/custom/checkout" },
    { request: "do it", favorite_name: 12 },
  ]) {
    const res = await send("POST", "/api/epics/e/requests", body);
    assert.equal(res.status, 400, JSON.stringify({ body, res: res.body }));
  }
  assert.equal(db.listTasks().length, 0);
}));

test("epic request: a working directory is free text, not a repo pick", () => withApi(async (send, db) => {
  const saved = await send("PATCH", "/api/epics/e", { repo_path: "/some/custom/checkout" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.epic.repo_path, "/some/custom/checkout");

  const created = await send("POST", "/api/epics/e/requests", {
    request: "Follow up in a folder Corral does not know yet",
    repo_path: "  /another/custom/checkout  ",
    favorite_name: "Work",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.repo_path, "/another/custom/checkout");
  assert.equal(created.body.target, "claude", "a custom path uses the professional favorite context");
  assert.equal(db.getEpic("e")!.repo_path, "/another/custom/checkout");
  assert.equal(db.listRepos().some((r) => r.path === "/another/custom/checkout"), false, "a typed path does not register a repo");
}));
