import { test } from "node:test";
import assert from "node:assert/strict";
import { selectedInboxItem } from "../../web/src/inbox-selection.ts";
import type { Item } from "../../web/src/types.ts";

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

test("in-progress inbox contains resolved items only for dispatched tasks", async () => {
  const { inProgressInboxItems } = await import("../../web/src/inbox-selection.ts");
  const active = { id: "active", status: "resolved", task_id: "working" } as Item;
  const open = { id: "open", status: "open", task_id: "working" } as Item;
  const archived = { id: "archived", status: "archived", task_id: "working" } as Item;
  const finished = { id: "finished", status: "resolved", task_id: "done" } as Item;
  const unlinked = { id: "unlinked", status: "resolved", task_id: null } as Item;
  const tasks = [{ id: "working", status: "dispatched" }, { id: "done", status: "done" }] as import("../../web/src/types.ts").Task[];
  assert.deepEqual(inProgressInboxItems([active, open, archived, finished, unlinked], tasks), [active]);
});

test("in-progress inbox includes dispatched tasks without any inbox item", async () => {
  const { inProgressInboxTasks } = await import("../../web/src/inbox-selection.ts");
  const tasks = [{ id: "working", status: "dispatched" }, { id: "new", status: "open" }, { id: "finished", status: "done" }] as import("../../web/src/types.ts").Task[];
  assert.deepEqual(inProgressInboxTasks(tasks).map((task) => task.id), ["working"]);
});

test("a PR item the agent is handling leaves the open inbox for in progress", async () => {
  const { openInboxItems, inProgressInboxItems, selectedInboxItem } = await import("../../web/src/inbox-selection.ts");
  const handling = { id: "handling", kind: "pr", status: "open", handling: 1, ready: 0, task_id: "done-task" } as Item;
  const waiting = { id: "waiting", kind: "pr", status: "open", handling: 0, ready: 0, task_id: "done-task" } as Item;
  // The task already reported done: only the handling flag keeps the item around.
  const tasks = [{ id: "done-task", status: "done" }] as import("../../web/src/types.ts").Task[];
  assert.deepEqual(openInboxItems([handling, waiting]).map((i) => i.id), ["waiting"]);
  assert.deepEqual(inProgressInboxItems([handling, waiting], tasks).map((i) => i.id), ["handling"]);
  assert.equal(selectedInboxItem(handling, [handling], "in-progress"), handling);
  assert.equal(selectedInboxItem(handling, [handling], "open"), null);
});

test("an archived item leaves in progress even while it is handled", async () => {
  const { inProgressInboxItems } = await import("../../web/src/inbox-selection.ts");
  const archived = { id: "archived", kind: "pr", status: "archived", handling: 1, ready: 0, task_id: null } as Item;
  assert.deepEqual(inProgressInboxItems([archived], []), []);
});
