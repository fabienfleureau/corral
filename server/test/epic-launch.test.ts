// Starting an epic task is an explicit action on the Epic page: the route
// rechecks readiness, stacks the branch and cleans up older inbox items.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer, type AppState } from "../api.ts";
import type { Config } from "../config.ts";
import { Db } from "../db.ts";
import type { Item, Task } from "../types.ts";
import type { WorkerBackend, WorkerSession, WorkerStart } from "../worker.ts";

function fakeBackend(started: WorkerStart[]): WorkerBackend {
  return {
    name: "fake",
    async start(s: WorkerStart): Promise<WorkerSession> {
      started.push(s);
      return {
        address: `session-${started.length}`, task_id: s.taskId, name: s.name, harness: s.harness,
        status: "working", blocked_kind: null, state: "live", turn: 1, cwd: s.repoPath,
        created_ms: Date.now(), exit_code: null, parent: null,
      };
    },
    list: async () => [], get: async () => null, read: async () => "", send: async () => undefined,
    resolveElicitation: async () => undefined, kill: async () => undefined, history: async () => "",
    tree: async () => [], onEvent: () => ({ stop: () => undefined }),
  } as unknown as WorkerBackend;
}

test("epic launch: only a ready task starts, from the Epic page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-launch-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"]);
  execFileSync("git", ["-C", dir, "branch", "feat/e1"]);
  const db = new Db(":memory:");
  const started: WorkerStart[] = [];
  const server = createHttpServer({
    db,
    cfg: { token: "test", configDir: dir, host: "localhost", port: 4787 } as Config,
    backend: fakeBackend(started),
    hub: { broadcast() { /* no clients */ } },
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string) => {
    const res = await fetch(url + path, {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: "{}",
    });
    return { status: res.status, body: await res.json() as { error?: string } };
  };
  const get = async (path: string) => {
    const res = await fetch(url + path, { headers: { Authorization: "Bearer test" } });
    return { status: res.status, body: await res.json() as { tasks: { id: string }[]; views: { task: { id: string } }[] } };
  };
  try {
    const now = Date.now();
    db.insertEpic({ id: "e", jira_key: "E-1", title: "E", description: "", error: null, synced_ms: now, created_ms: now });
    const task = (id: string, over: Partial<Task> = {}): Task => ({
      id, title: `${id} t`, prompt: "work", repo_path: dir, target: "codex", target_state: "confirmed",
      base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: id,
      jira_url: null, jira_parent_key: null, jira_status: null, pr_url: null, pr_meta: null,
      status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now,
      epic_id: "e", epic_out: 0, ...over,
    });
    db.insertTask(task("E-1", { status: "dispatched", branch: "feat/e1", terminal_address: "s0", pr_url: "u" }));
    db.insertTask(task("E-2"));
    db.insertTask(task("E-3"));
    db.insertTask(task("request-1", { jira_key: null, title: "Draft release notes" }));
    db.replaceEpicLinks("e", [
      { task_key: "E-2", blocked_by_key: "E-1" },
      { task_key: "E-3", blocked_by_key: "E-2" },
    ]);
    const pr: Item = {
      id: "pr-e1", kind: "pr", status: "open", title: "", summary: "", body: "", context: "", options: null,
      ready: 1, handling: 0, source_ref: null, task_id: "E-1", structured: 1,
      created_ms: now, updated_ms: now, resolved_ms: null, snooze_until_ms: null,
    };
    db.insertItem(pr);
    const legacy: Item = {
      ...pr, id: "old-launch", kind: "launch", task_id: "E-2", title: "Ready to launch: E-2 t",
    };
    db.insertItem(legacy);

    const detail = await get("/api/epics/e");
    assert.equal(detail.status, 200);
    assert.ok(!detail.body.tasks.some((t) => t.id === "request-1"), "a prompt task is not board data");
    assert.ok(!detail.body.views.some((v) => v.task.id === "request-1"), "a prompt task is not a board view");

    assert.equal(db.listItems({ kind: "launch" }).filter((i) => i.status === "open").length, 1, "only the legacy item exists");
    const notJira = await post("/api/epics/e/tasks/request-1/launch");
    assert.equal(notJira.status, 409);
    assert.match(notJira.body.error ?? "", /Jira/);
    assert.equal(started.length, 0, "a prompt task never launches from the epic");

    const blocked = await post("/api/epics/e/tasks/E-3/launch");
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error ?? "", /blocked/);
    assert.equal(started.length, 0, "a blocked task never starts");

    const launched = await post("/api/epics/e/tasks/E-2/launch");
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    assert.equal(started.length, 1);
    assert.equal(db.getTask("E-2")!.status, "dispatched");
    assert.equal(db.getTask("E-2")!.base_branch, "feat/e1");
    assert.equal(started[0].git?.base, execFileSync("git", ["-C", dir, "rev-parse", "feat/e1"]).toString().trim());
    assert.equal(db.getItem(legacy.id)!.status, "archived", "old inbox item is cleaned up on launch");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
