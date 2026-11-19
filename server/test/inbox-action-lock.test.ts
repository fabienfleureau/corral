import { test } from "node:test";
import assert from "node:assert/strict";
import { INBOX_ACTION_COOLDOWN_MS, inboxActionsLocked } from "../../web/src/inbox-action-lock.ts";

test("inbox buttons stay locked during the request and after it completes", () => {
  const at = 1000;
  const unlockAt = at + INBOX_ACTION_COOLDOWN_MS;
  assert.equal(inboxActionsLocked(true, 0, at), true);
  assert.equal(inboxActionsLocked(false, unlockAt, at), true);
  assert.equal(inboxActionsLocked(false, unlockAt, unlockAt - 1), true);
  assert.equal(inboxActionsLocked(false, unlockAt, unlockAt), false);
});

test("the cooldown survives the detail pane switching to another item", () => {
  const unlockAt = 1500;
  assert.equal(inboxActionsLocked(false, unlockAt, 1400), true);
  assert.equal(inboxActionsLocked(false, unlockAt, 1600), false);
});
