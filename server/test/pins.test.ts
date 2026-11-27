import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPinned,
  MAX_PINS,
  parseStoredPins,
  sameQuickJumpRef,
  togglePin,
  visiblePins,
  type QuickJumpRef,
} from "../../web/src/pins.ts";

test("parseStoredPins ignores invalid JSON, malformed items, duplicates, and caps at max", () => {
  assert.deepEqual(parseStoredPins(null), []);
  assert.deepEqual(parseStoredPins("{not-json"), []);
  assert.deepEqual(parseStoredPins("42"), []);
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
  assert.deepEqual(parseStoredPins(raw, 3), [
    { kind: "item", id: "a" },
    { kind: "task", id: "t1" },
    { kind: "item", id: "b" },
  ]);
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

test("visiblePins drops stale refs and sameQuickJumpRef compares kind and id", () => {
  const pins: QuickJumpRef[] = [
    { kind: "item", id: "i1" },
    { kind: "item", id: "gone" },
  ];
  const existing = new Set(["item:i1", "task:t1"]);
  const visible = visiblePins(pins, (ref) => existing.has(`${ref.kind}:${ref.id}`));
  assert.deepEqual(visible, [{ kind: "item", id: "i1" }]);
  assert.equal(sameQuickJumpRef(pins[0], { kind: "item", id: "i1" }), true);
  assert.equal(sameQuickJumpRef(pins[0], { kind: "task", id: "i1" }), false);
});
