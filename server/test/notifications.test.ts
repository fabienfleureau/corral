import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createNotificationTracker } from "../../web/src/notifications.ts";
import type { Item } from "../../web/src/types.ts";

const item = (overrides: Partial<Item> = {}): Item => ({
  id: "one", kind: "question", status: "open", title: "Question", summary: "", body: "Help",
  context: "", options: null, elicitation: null, source_ref: null, task_id: null, structured: 1,
  ready: 1, handling: 0, created_ms: 1, updated_ms: 1, resolved_ms: null, snooze_until_ms: null, ...overrides,
});

test("notifies again when a question is reopened, but not for repeated updates", () => {
  const track = createNotificationTracker();
  const question = item();
  assert.equal(track({ type: "item.created", item: question }), question);
  assert.equal(track({ type: "item.updated", item: question }), null);
  assert.equal(track({ type: "item.updated", item: item({ status: "resolved" }) }), null);
  assert.equal(track({ type: "item.updated", item: question }), question);
});

test("notifies when a PR becomes ready again", () => {
  const track = createNotificationTracker();
  const ready = item({ kind: "pr" });
  const unready = item({ kind: "pr", ready: 0 });
  assert.equal(track({ type: "item.created", item: unready }), unready);
  assert.equal(track({ type: "item.updated", item: unready }), null);
  assert.equal(track({ type: "item.updated", item: ready }), ready);
  assert.equal(track({ type: "item.updated", item: ready }), null);
  assert.equal(track({ type: "item.updated", item: unready }), null);
  assert.equal(track({ type: "item.updated", item: ready }), ready);
});

test("notifies on arrival and readiness again after a PR is reopened", () => {
  const track = createNotificationTracker();
  const unready = item({ kind: "pr", ready: 0 });
  const ready = item({ kind: "pr" });
  assert.equal(track({ type: "item.created", item: unready }), unready);
  assert.equal(track({ type: "item.updated", item: item({ kind: "pr", status: "resolved" }) }), null);
  assert.equal(track({ type: "item.updated", item: unready }), unready);
  assert.equal(track({ type: "item.updated", item: ready }), ready);
});

test("sends a desktop notification and reports construction failures", async () => {
  const { sendDesktopNotification } = await import("../../web/src/notifications.ts");
  const globals = globalThis as unknown as { Notification?: unknown };
  const original = globals.Notification;
  const sent: Array<{ title: string; body: string | undefined }> = [];
  try {
    globals.Notification = class {
      static permission = "granted";
      constructor(title: string, options?: { body?: string }) {
        sent.push({ title, body: options?.body });
      }
    };
    assert.equal(sendDesktopNotification("Test", "Hello"), true);
    assert.deepEqual(sent, [{ title: "Test", body: "Hello" }]);
    globals.Notification = class {
      static permission = "granted";
      constructor() { throw new Error("unavailable"); }
    };
    assert.equal(sendDesktopNotification("Test", "Hello"), false);
  } finally {
    globals.Notification = original;
  }
});

test("reports asynchronous notification errors", async () => {
  const { sendDesktopNotification } = await import("../../web/src/notifications.ts");
  const globals = globalThis as unknown as { Notification?: unknown };
  const original = globals.Notification;
  let notification: { onerror: (() => void) | null } | undefined;
  let failed = false;
  try {
    globals.Notification = class {
      static permission = "granted";
      onerror: (() => void) | null = null;
      constructor() { notification = this; }
    };
    sendDesktopNotification("Test", "Hello", () => { failed = true; });
    notification?.onerror?.();
    assert.equal(failed, true);
  } finally {
    globals.Notification = original;
  }
});

test("inbox indicator tracks unseen items rather than the open count", async () => {
  const { unseenInboxItems, rememberInboxItems } = await import("../../web/src/inbox-seen.ts");
  const first = item();
  const second = item({ id: "two" });
  assert.equal(unseenInboxItems([first], []), true);
  const seen = rememberInboxItems([], [first]);
  assert.equal(unseenInboxItems([first], seen), false);
  assert.equal(unseenInboxItems([first, second], seen), true);
  assert.equal(unseenInboxItems([first, second], rememberInboxItems(seen, [first, second])), false);
});
