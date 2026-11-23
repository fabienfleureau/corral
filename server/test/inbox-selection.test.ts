import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRunStatus, selectedInboxItem, taskLocation } from "../../web/src/inbox-selection.ts";
import type { Item, Repo, SessionInfo, Task, TrackedTerminal } from "../../web/src/types.ts";

test("an archived selected item leaves the open inbox detail", () => {
  const open = { id: "one", status: "open" } as Item;
  const archived = { ...open, status: "archived" } as Item;
  assert.equal(selectedInboxItem(open, [archived], "open"), null);
});

test("snoozed open items disappear until their deadline", async () => {
  const { visibleInboxItems } = await import("../../web/src/inbox-selection.ts");
  const snoozed = { id: "one", status: "open", snooze_until_ms: 2000 } as Item;
  const open = { id: "two", status: "open", snooze_until_ms: null } as Item;
  assert.deepEqual(visibleInboxItems([snoozed, open], 1000), [open]);
  assert.deepEqual(visibleInboxItems([snoozed, open], 2000), [snoozed, open]);
  assert.equal(selectedInboxItem(snoozed, visibleInboxItems([snoozed, open], 1000), "open"), null);
});

test("snoozed view contains only open items postponed beyond the current time", async () => {
  const { visibleInboxItems, selectedInboxItem } = await import("../../web/src/inbox-selection.ts");
  const snoozed = { id: "snoozed", status: "open", snooze_until_ms: 2000 } as Item;
  const expired = { id: "expired", status: "open", snooze_until_ms: 1000 } as Item;
  const resolved = { id: "resolved", status: "resolved", snooze_until_ms: 2000 } as Item;
  const items = [snoozed, expired, resolved];
  assert.deepEqual(visibleInboxItems(items, 1000, "snoozed"), [snoozed]);
  assert.equal(selectedInboxItem(snoozed, [snoozed], "snoozed"), snoozed);
  assert.deepEqual(visibleInboxItems(items, 2000, "snoozed"), []);
});

test("in-progress inbox does not repeat resolved items for dispatched tasks", async () => {
  const { inProgressInboxItems, inProgressInboxTasks, selectedInboxItem } = await import("../../web/src/inbox-selection.ts");
  const resolved = { id: "resolved", status: "resolved", task_id: "working" } as Item;
  const open = { id: "open", status: "open", task_id: "working" } as Item;
  const archived = { id: "archived", status: "archived", task_id: "working" } as Item;
  const finished = { id: "finished", status: "resolved", task_id: "done" } as Item;
  const unlinked = { id: "unlinked", status: "resolved", task_id: null } as Item;
  const tasks = [{ id: "working", status: "dispatched", terminal_address: "s1" }, { id: "done", status: "done", terminal_address: "s2" }] as Task[];
  assert.deepEqual(inProgressInboxItems([resolved, open, archived, finished, unlinked], tasks), []);
  assert.deepEqual(inProgressInboxTasks(tasks, [resolved, open, archived, finished, unlinked]).map((t) => t.id), ["working"]);
  assert.equal(selectedInboxItem(resolved, [resolved], "in-progress"), null);
});

test("in-progress inbox deduplicates dispatched tasks already represented by a handled item", async () => {
  const { inProgressInboxTasks, inProgressInboxItems } = await import("../../web/src/inbox-selection.ts");
  const tasks = [
    { id: "working-pr", status: "dispatched", terminal_address: "s1" },
    { id: "working-session", status: "dispatched", terminal_address: "s2" },
    { id: "working-alone", status: "dispatched", terminal_address: "s3" },
    { id: "new", status: "open", terminal_address: null },
    { id: "finished", status: "done", terminal_address: "s4" },
  ] as Task[];
  const items = [
    { id: "pr-by-task", kind: "pr", status: "open", handling: 1, task_id: "working-pr", source_ref: null },
    { id: "pr-by-session", kind: "pr", status: "open", handling: 1, task_id: null, source_ref: "s2" },
    { id: "pr-archived", kind: "pr", status: "archived", handling: 1, task_id: "working-alone", source_ref: "s3" },
  ] as Item[];
  assert.deepEqual(inProgressInboxItems(items, tasks).map((i) => i.id), ["pr-by-task", "pr-by-session"]);
  assert.deepEqual(inProgressInboxTasks(tasks, items).map((t) => t.id), ["working-alone"]);
});

test("in-progress inbox excludes dispatched tasks whose agent is stopped", async () => {
  const { inProgressInboxTasks } = await import("../../web/src/inbox-selection.ts");
  const tasks = [
    { id: "running", status: "dispatched", terminal_address: "s-running" },
    { id: "blocked", status: "dispatched", terminal_address: "s-blocked" },
    { id: "idle", status: "dispatched", terminal_address: "s-idle" },
    { id: "done-run", status: "dispatched", terminal_address: "s-done" },
    { id: "error-run", status: "dispatched", terminal_address: "s-error" },
    { id: "finished", status: "dispatched", terminal_address: "s-finished" },
    { id: "terminal-stopped", status: "dispatched", terminal_address: "s-term-stopped" },
    { id: "terminal-running", status: "dispatched", terminal_address: "s-term-running" },
    { id: "unknown", status: "dispatched", terminal_address: "s-unknown" },
  ] as Task[];
  const sessions = [
    session("s-running", "working"),
    session("s-blocked", "blocked"),
    session("s-idle", "idle"),
    session("s-done", "done"),
    session("s-error", "error"),
    session("s-finished", "working", "finished"),
  ];
  const terminals = [
    terminal("s-term-stopped", "idle"),
    terminal("s-term-running", "working"),
  ];
  assert.deepEqual(
    inProgressInboxTasks(tasks, [], sessions, terminals).map((t) => t.id),
    ["running", "blocked", "terminal-running", "unknown"],
  );
});

test("a PR item the agent is handling leaves the open inbox for in progress", async () => {
  const { openInboxItems, inProgressInboxItems, selectedInboxItem, visibleInboxItems } = await import("../../web/src/inbox-selection.ts");
  const handling = { id: "handling", kind: "pr", status: "open", handling: 1, ready: 0, task_id: "done-task", snooze_until_ms: null } as Item;
  const snoozedHandling = { id: "snoozed-handling", kind: "pr", status: "open", handling: 1, ready: 0, task_id: "done-task", snooze_until_ms: 2000 } as Item;
  const waiting = { id: "waiting", kind: "pr", status: "open", handling: 0, ready: 0, task_id: "done-task", snooze_until_ms: null } as Item;
  // The task already reported done: only the handling flag keeps the item around.
  const tasks = [{ id: "done-task", status: "done" }] as import("../../web/src/types.ts").Task[];
  assert.deepEqual(openInboxItems([handling, waiting]).map((i) => i.id), ["waiting"]);
  assert.deepEqual(inProgressInboxItems([handling, snoozedHandling, waiting], tasks).map((i) => i.id), ["handling", "snoozed-handling"]);
  assert.deepEqual(visibleInboxItems([snoozedHandling], 1000, "snoozed"), []);
  assert.equal(selectedInboxItem(handling, [handling], "in-progress"), handling);
  assert.equal(selectedInboxItem(handling, [handling], "open"), null);
  assert.equal(selectedInboxItem(snoozedHandling, [snoozedHandling], "snoozed"), null);
});

test("an archived item leaves in progress even while it is handled", async () => {
  const { inProgressInboxItems } = await import("../../web/src/inbox-selection.ts");
  const archived = { id: "archived", kind: "pr", status: "archived", handling: 1, ready: 0, task_id: null } as Item;
  assert.deepEqual(inProgressInboxItems([archived], []), []);
});

const task = (id: string, terminal_address: string | null = `session-${id}`) => ({ id, terminal_address }) as Task;
const session = (address: string, status: string | null, state = "live") =>
  ({ address, status, state }) as SessionInfo;
const terminal = (address: string, last_status: string | null) =>
  ({ address, last_status }) as TrackedTerminal;

test("a live Omnigent session reads as running, including a blocked one", () => {
  assert.equal(agentRunStatus(task("one"), [session("session-one", "working")], []), "running");
  assert.equal(agentRunStatus(task("one"), [session("session-one", "blocked")], []), "running");
});

test("a stopped or finished Omnigent session reads as stopped", () => {
  for (const status of ["idle", "done", "error"]) {
    assert.equal(agentRunStatus(task("one"), [session("session-one", status)], []), "stopped", status);
  }
  assert.equal(agentRunStatus(task("one"), [session("session-one", "working", "finished")], []), "stopped");
});

test("tracked terminals give the last status when the worker has no session listed", () => {
  assert.equal(agentRunStatus(task("one"), [], [terminal("session-one", "working")]), "running");
  assert.equal(agentRunStatus(task("one"), [], [terminal("session-one", "error")]), "stopped");
  // A live answer wins over an older status recorded in the terminal.
  assert.equal(agentRunStatus(task("one"), [session("session-one", "working")], [terminal("session-one", "idle")]), "running");
});

test("a task without a session or a known status reads as unknown", () => {
  assert.equal(agentRunStatus(task("one"), [], []), "unknown");
  assert.equal(agentRunStatus({ id: "one", terminal_address: null } as Task, [], []), "unknown");
  assert.equal(agentRunStatus(task("one"), [session("session-one", null, "unknown")], [terminal("session-one", null)]), "unknown");
});

test("a session with no terminal address is matched by task id", () => {
  const noAddress = task("one", null);
  assert.equal(agentRunStatus(noAddress, [{ ...session("other", "working"), task_id: "one" }], []), "running");
  assert.equal(agentRunStatus(noAddress, [], [{ ...terminal("other", "idle"), task_id: "one" }]), "stopped");
});

test("taskLocation resolves registered repos by name and unregistered folders by basename", () => {
  const repos = [
    { id: "r1", name: "example-project", path: "/sample/example-project" },
    { id: "r2", name: "Side App", path: "/sample/side-project/" },
  ] as Repo[];

  assert.deepEqual(
    taskLocation({ repo_path: "/sample/example-project" }, repos),
    { label: "example-project", path: "/sample/example-project", isRepo: true },
  );
  assert.deepEqual(
    taskLocation({ repo_path: "/sample/example-project/" }, repos),
    { label: "example-project", path: "/sample/example-project", isRepo: true },
  );
  assert.deepEqual(
    taskLocation({ repo_path: "/sample/side-project" }, repos),
    { label: "Side App", path: "/sample/side-project/", isRepo: true },
  );
  assert.deepEqual(
    taskLocation({ repo_path: "/sample/workspace" }, repos),
    { label: "workspace", path: "/sample/workspace", isRepo: false },
  );
  assert.deepEqual(
    taskLocation({ repo_path: "/sample/workspace/" }, repos),
    { label: "workspace", path: "/sample/workspace/", isRepo: false },
  );
  assert.deepEqual(
    taskLocation({ repo_path: "/" }, repos),
    { label: "/", path: "/", isRepo: false },
  );
  assert.equal(taskLocation({ repo_path: "" }, repos), null);
  assert.equal(taskLocation({ repo_path: "   " }, repos), null);
  assert.equal(taskLocation(null, repos), null);
});
