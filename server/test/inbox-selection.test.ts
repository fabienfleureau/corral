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
