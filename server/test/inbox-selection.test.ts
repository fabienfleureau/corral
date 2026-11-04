import { test } from "node:test";
import assert from "node:assert/strict";
import { selectedInboxItem } from "../../web/src/inbox-selection.ts";
import type { Item } from "../../web/src/types.ts";

test("an archived selected item leaves the open inbox detail", () => {
  const open = { id: "one", status: "open" } as Item;
  const archived = { ...open, status: "archived" } as Item;
  assert.equal(selectedInboxItem(open, [archived], "open"), null);
});
