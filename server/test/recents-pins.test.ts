import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPinned,
  MAX_PINS,
  MAX_RECENTS,
  parseStoredRefs,
  recordRecent,
  sameQuickJumpRef,
  togglePin,
  visibleStripEntries,
  type QuickJumpRef,
} from "../../web/src/recents-pins.ts";

test("parseStoredRefs ignores invalid JSON, malformed items, duplicates, and caps at max", () => {
  assert.deepEqual(parseStoredRefs(null, MAX_RECENTS), []);
  assert.deepEqual(parseStoredRefs("{not-json", MAX_RECENTS), []);
  assert.deepEqual(parseStoredRefs("42", MAX_RECENTS), []);
  const raw = JSON.stringify([
    null,
    { kind: "other", id: "1" },
    { kind: "item", id: "" },
    { kind: "item", id: "a" },
    { kind: "item", id: "a" },
    { kind: "task", id: "t1" },
    { kind: "item", id: "b" },
    { kind: "item", id: "c" },
  ]);
  assert.deepEqual(parseStoredRefs(raw, 3), [
    { kind: "item", id: "a" },
    { kind: "task", id: "t1" },
    { kind: "item", id: "b" },
  ]);
});

test("recordRecent moves an entry to the front without duplicates and respects cap", () => {
  let recents: QuickJumpRef[] = [];
  for (let i = 1; i <= MAX_RECENTS + 2; i++) {
    recents = recordRecent(recents, { kind: "item", id: `i${i}` });
  }
  assert.equal(recents.length, MAX_RECENTS);
  assert.deepEqual(recents[0], { kind: "item", id: `i${MAX_RECENTS + 2}` });

  const bumped = recordRecent(recents, { kind: "item", id: "i4" });
  assert.equal(bumped.length, MAX_RECENTS);
  assert.deepEqual(bumped[0], { kind: "item", id: "i4" });
  assert.equal(bumped.filter((r) => sameQuickJumpRef(r, { kind: "item", id: "i4" })).length, 1);
});

test("togglePin adds, removes, and caps pins", () => {
  let pins: QuickJumpRef[] = [];
  const t1: QuickJumpRef = { kind: "task", id: "t1" };
  pins = togglePin(pins, t1);
  assert.equal(isPinned(pins, t1), true);
  pins = togglePin(pins, t1);
  assert.equal(isPinned(pins, t1), false);

  for (let i = 1; i <= MAX_PINS + 2; i++) {
    pins = togglePin(pins, { kind: "task", id: `t${i}` });
  }
  assert.equal(pins.length, MAX_PINS);
});

test("visibleStripEntries filters stale refs and omits pinned items from recents", () => {
  const pins: QuickJumpRef[] = [
    { kind: "item", id: "i1" },
    { kind: "item", id: "gone" },
  ];
  const recents: QuickJumpRef[] = [
    { kind: "item", id: "i1" },
    { kind: "task", id: "t1" },
    { kind: "item", id: "missing" },
  ];
  const existing = new Set(["item:i1", "task:t1"]);
  const visible = visibleStripEntries(pins, recents, (ref) => existing.has(`${ref.kind}:${ref.id}`));
  assert.deepEqual(visible, {
    pinned: [{ kind: "item", id: "i1" }],
    recents: [{ kind: "task", id: "t1" }],
  });
});
