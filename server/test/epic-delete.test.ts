// Removing an epic from Corral: clears epic-owned tables and epic-owned
// inbox items, detaches linked tasks without deleting them, leaves Jira and
// other epics untouched, and handles re-import and in-flight agent cycles.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer, type AppState } from "../api.ts";
import type { Config } from "../config.ts";
import { Db } from "../db.ts";
import { syncEpic, type EpicJira } from "../epic.ts";
import { EpicAgentRunner } from "../epic-agent.ts";
import type { JiraIssue } from "../jira.ts";
import type { Item, Task } from "../types.ts";
import type { WorkerBackend } from "../worker.ts";

function makeTask(id: string, over: Partial<Task> = {}): Task {
  const now = 1_700_000_000_000;
  return {
    id,
    title: id,
    prompt: `Work on ${id}`,
    repo_path: "/tmp/repo",
    target: "claude",
    target_state: "confirmed",
    base_branch: null,
    branch: null,
    worktree_path: null,
    assignee: null,
    jira_key: null,
    jira_url: null,
    jira_parent_key: null,
    jira_status: null,
    pr_url: null,
    pr_meta: null,
    status: "open",
    terminal_address: null,
    exit_code: null,
    created_ms: now,
    updated_ms: now,
    epic_id: null,
    epic_out: 0,
    ...over,
  };
}

function makeItem(id: string, over: Partial<Item> = {}): Item {
  const now = 1_700_000_000_000;
  return {
    id,
    kind: "question",
    status: "open",
    title: id,
    summary: "",
    body: "",
    context: "",
    options: null,
    ready: 1,
    handling: 0,
    source_ref: null,
    task_id: null,
    structured: 1,
    created_ms: now,
    updated_ms: now,
    resolved_ms: null,
    snooze_until_ms: null,
    ...over,
  };
}

test("DELETE /api/epics/:id returns 404 when epic does not exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-del-404-"));
  const db = new Db(":memory:");
  const server = createHttpServer({
    db,
    cfg: { token: "test", configDir: dir, host: "localhost", port: 4787 } as Config,
    backend: { list: async () => [], get: async () => null } as unknown as WorkerBackend,
    hub: { broadcast() { /* no clients */ } },
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${url}/api/epics/missing`, {
      method: "DELETE",
      headers: { Authorization: "Bearer test" },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "epic not found" });
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DELETE /api/epics/:id removes epic-owned records, detaches tasks, archives epic items, and allows re-import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-del-"));
  const db = new Db(":memory:");
  const events: { event: string; payload: unknown }[] = [];
  const server = createHttpServer({
    db,
    cfg: { token: "test", configDir: dir, host: "localhost", port: 4787 } as Config,
    backend: { list: async () => [], get: async () => null } as unknown as WorkerBackend,
    hub: { broadcast(event: string, payload: unknown) { events.push({ event, payload }); } },
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const now = 1_700_000_000_000;
    db.insertEpic({ id: "e1", jira_key: "E-1", title: "Epic One", description: "Design", error: null, synced_ms: now, created_ms: now });
    db.insertEpic({ id: "e2", jira_key: "E-2", title: "Epic Two", description: "Keep me", error: null, synced_ms: now, created_ms: now + 1 });

    // Linked tasks on e1 (Jira-backed and prompt-created) + one on e2.
    db.insertTask(makeTask("t-jira", { epic_id: "e1", epic_out: 1, jira_key: "E-101", status: "dispatched", prompt: "Original prompt" }));
    db.insertTask(makeTask("t-req", { epic_id: "e1", kind: "ops", prompt: "Epic request prompt" }));
    db.insertTask(makeTask("t-other", { epic_id: "e2", jira_key: "E-201" }));

    // Epic-owned metadata tables for e1 and e2.
    db.replaceEpicLinks("e1", [{ task_key: "E-102", blocked_by_key: "E-101" }]);
    db.replaceEpicLinks("e2", [{ task_key: "E-202", blocked_by_key: "E-201" }]);
    db.replaceEpicTickets("e1", [{
      epic_id: "e1", jira_key: "E-101", title: "Ticket 101", description: "", jira_url: "https://j/E-101",
      jira_status: "To Do", jira_parent_key: "E-1", suggested_repo_path: "", updated_ms: now,
    }]);
    db.replaceEpicTickets("e2", [{
      epic_id: "e2", jira_key: "E-201", title: "Ticket 201", description: "", jira_url: "https://j/E-201",
      jira_status: "To Do", jira_parent_key: "E-2", suggested_repo_path: "", updated_ms: now,
    }]);
    db.insertDesign({ epic_id: "e1", version: 1, body: "v1", reason: "init", author: "jira", created_ms: now });
    db.insertDesign({ epic_id: "e2", version: 1, body: "v1", reason: "init", author: "jira", created_ms: now });
    db.raw.prepare("INSERT INTO epic_agents (epic_id, settings, run_state) VALUES (?, ?, ?)").run("e1", "{}", "complete");
    db.raw.prepare("INSERT INTO epic_agents (epic_id, settings, run_state) VALUES (?, ?, ?)").run("e2", "{}", "complete");

    // Inbox items: open amendment + legacy launch item belong to e1; pr + question stay open; e2 amendment stays open.
    db.insertItem(makeItem("item-amend-e1", { kind: "amendment", task_id: "t-jira" }));
    db.insertAmendment({ id: "a1", epic_id: "e1", task_id: "t-jira", design_version: 1, body: "Change", status: "proposed", item_id: "item-amend-e1", created_ms: now });
    db.insertItem(makeItem("item-launch-e1", { kind: "launch", task_id: "t-jira" }));
    db.insertItem(makeItem("item-pr-e1", { kind: "pr", task_id: "t-jira" }));
    db.insertItem(makeItem("item-q-e1", { kind: "question", task_id: "t-req" }));
    db.insertItem(makeItem("item-amend-e2", { kind: "amendment", task_id: "t-other" }));
    db.insertAmendment({ id: "a2", epic_id: "e2", task_id: "t-other", design_version: 1, body: "Keep", status: "proposed", item_id: "item-amend-e2", created_ms: now });

    const res = await fetch(`${url}/api/epics/e1`, {
      method: "DELETE",
      headers: { Authorization: "Bearer test" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    // GET /api/epics/e1 is now 404; e2 remains intact.
    const getDeleted = await fetch(`${url}/api/epics/e1`, { headers: { Authorization: "Bearer test" } });
    assert.equal(getDeleted.status, 404);
    assert.equal(db.getEpic("e1"), null);
    assert.ok(db.getEpic("e2"));

    // All six epic tables cleared for e1, untouched for e2.
    assert.equal(db.listEpicLinks("e1").length, 0);
    assert.equal(db.listEpicTickets("e1").length, 0);
    assert.equal(db.listDesigns("e1").length, 0);
    assert.equal(db.listAmendments("e1").length, 0);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM epic_agents WHERE epic_id = 'e1'").get()?.n, 0);
    assert.equal(db.listEpicLinks("e2").length, 1);
    assert.equal(db.listEpicTickets("e2").length, 1);
    assert.equal(db.listDesigns("e2").length, 1);
    assert.equal(db.listAmendments("e2").length, 1);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM epic_agents WHERE epic_id = 'e2'").get()?.n, 1);

    // Linked tasks are preserved and detached without changing status, prompt, or updated_ms.
    const tJira = db.getTask("t-jira")!;
    assert.equal(tJira.epic_id, null);
    assert.equal(tJira.epic_out, 0);
    assert.equal(tJira.status, "dispatched");
    assert.equal(tJira.prompt, "Original prompt");
    assert.equal(tJira.updated_ms, now);

    const tReq = db.getTask("t-req")!;
    assert.equal(tReq.epic_id, null);
    assert.equal(tReq.epic_out, 0);
    assert.equal(tReq.kind, "ops");
    assert.equal(tReq.updated_ms, now);

    assert.equal(db.getTask("t-other")?.epic_id, "e2");

    // Epic-owned items archived; task PR/question items and e2's amendment stay open.
    assert.equal(db.getItem("item-amend-e1")?.status, "archived");
    assert.equal(db.getItem("item-launch-e1")?.status, "archived");
    assert.equal(db.getItem("item-pr-e1")?.status, "open");
    assert.equal(db.getItem("item-q-e1")?.status, "open");
    assert.equal(db.getItem("item-amend-e2")?.status, "open");

    // Metric and SSE broadcasts recorded.
    assert.ok(db.recentMetrics(10).some((m) => m.name === "epic.deleted" && m.ref === "e1"));
    assert.ok(events.some((e) => e.event === "epic.deleted" && (e.payload as { id: string }).id === "e1"));
    assert.ok(events.some((e) => e.event === "task.updated" && (e.payload as Task).id === "t-jira"));
    assert.ok(events.some((e) => e.event === "task.updated" && (e.payload as Task).id === "t-req"));
    assert.ok(events.some((e) => e.event === "item.updated" && (e.payload as Item).id === "item-amend-e1"));
    assert.ok(events.some((e) => e.event === "item.updated" && (e.payload as Item).id === "item-launch-e1"));

    // Re-importing the same Jira key works cleanly and re-attaches existing Jira task.
    const epicIssue: JiraIssue = { key: "E-1", fields: { summary: "Epic One", description: "Design", status: { name: "In Progress" } } };
    const childIssue: JiraIssue = { key: "E-101", fields: { summary: "Ticket 101", description: "Updated", status: { name: "In Progress" }, parent: { key: "E-1" } } };
    const fakeJira: EpicJira = {
      getIssue: async () => epicIssue,
      epicChildren: async () => [childIssue],
      issueToTaskFields: (i) => ({
        title: `${i.key} ${i.fields.summary}`,
        prompt: String(i.fields.description ?? ""),
        jira_key: i.key,
        jira_url: `https://j/${i.key}`,
        jira_parent_key: "E-1",
        jira_status: i.fields.status?.name ?? null,
      }),
    };
    const resynced = await syncEpic(db, fakeJira, "E-1");
    assert.notEqual(resynced.epic.id, "e1");
    assert.equal(db.getTask("t-jira")?.epic_id, resynced.epic.id);
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EpicAgentRunner.tick() skips cleanly when the epic is deleted mid-flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-epic-del-agent-"));
  const db = new Db(":memory:");
  try {
    const now = 1_700_000_000_000;
    db.insertEpic({ id: "e1", jira_key: "E-1", title: "Epic One", description: "", error: null, synced_ms: now, created_ms: now });
    db.raw.prepare("INSERT INTO epic_agents (epic_id, settings, run_name, run_state, address, started_ms) VALUES (?, ?, ?, ?, ?, ?)")
      .run("e1", JSON.stringify({ repoPath: dir, favorite: "fav", intervalHours: 0, context: "" }), "run-1", "running", "sess-1", now);

    let deletedDuringPoll = false;
    const runner = new EpicAgentRunner(
      db,
      {
        start: async () => { throw new Error("not used"); },
        list: async () => [],
        get: async () => {
          if (!deletedDuringPoll) {
            deletedDuringPoll = true;
            db.deleteEpic("e1");
          }
          return {
            address: "sess-1", task_id: null, name: "run-1", harness: "claude",
            status: "idle", blocked_kind: null, state: "finished", turn: 1, cwd: dir,
            created_ms: now, exit_code: 0, parent: null,
          };
        },
        lastRunOutcome: async () => ({
          kind: "message",
          text: JSON.stringify({
            summary: "Done", steps: [], actionsTaken: [], problems: [], specGaps: [],
            clarifications: [], e2e: null, nextSteps: [], memory: "Should not be written",
          }),
        }),
      },
      { favorites: () => [], repos: () => [] },
      () => now + 1000,
    );

    await runner.tick();
    assert.equal(db.getEpic("e1"), null);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM epic_agents WHERE epic_id = 'e1'").get()?.n, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
