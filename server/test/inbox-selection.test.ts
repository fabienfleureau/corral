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
