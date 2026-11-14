import { test } from "node:test";
import assert from "node:assert/strict";
import { clampWidth, effectiveLimits, keyboardWidth, parseStoredFlag, parseStoredWidth } from "../../web/src/pane-size.ts";

const limits = { min: 160, max: 360 };

test("clampWidth keeps a width inside the limits and rounds it", () => {
  assert.equal(clampWidth(100, limits), 160);
  assert.equal(clampWidth(500, limits), 360);
  assert.equal(clampWidth(200.6, limits), 201);
  assert.equal(clampWidth(Number.NaN, limits), 160);
});

test("effectiveLimits trims the max so the neighbour keeps its room", () => {
  assert.deepEqual(effectiveLimits(limits, 700, 480), { min: 160, max: 220 });
  assert.deepEqual(effectiveLimits(limits, 1400, 480), limits);
});

test("effectiveLimits never drops the max below the min on a tiny container", () => {
  assert.deepEqual(effectiveLimits(limits, 400, 480), { min: 160, max: 160 });
});

test("effectiveLimits ignores an unmeasured container", () => {
  assert.deepEqual(effectiveLimits(limits, 0, 480), limits);
  assert.deepEqual(effectiveLimits(limits, Number.NaN, 480), limits);
});

test("parseStoredWidth falls back on missing, malformed or out-of-range values", () => {
  assert.equal(parseStoredWidth(null, limits, 200), 200);
  assert.equal(parseStoredWidth("", limits, 200), 200);
  assert.equal(parseStoredWidth("wide", limits, 200), 200);
  assert.equal(parseStoredWidth("50", limits, 200), 200);
  assert.equal(parseStoredWidth("9999", limits, 200), 200);
  assert.equal(parseStoredWidth("240", limits, 200), 240);
});

test("parseStoredFlag reads only the stored 1", () => {
  assert.equal(parseStoredFlag("1"), true);
  assert.equal(parseStoredFlag("0"), false);
  assert.equal(parseStoredFlag(null), false);
  assert.equal(parseStoredFlag("true"), false);
});

test("keyboardWidth: Right grows, Left shrinks, Shift takes the large step", () => {
  assert.equal(keyboardWidth("ArrowRight", 200, limits, false), 216);
  assert.equal(keyboardWidth("ArrowLeft", 200, limits, false), 184);
  assert.equal(keyboardWidth("ArrowRight", 200, limits, true), 264);
  assert.equal(keyboardWidth("ArrowLeft", 200, limits, true), 160);
});

test("keyboardWidth clamps, jumps with Home/End and ignores other keys", () => {
  assert.equal(keyboardWidth("ArrowRight", 355, limits, false), 360);
  assert.equal(keyboardWidth("ArrowLeft", 165, limits, false), 160);
  assert.equal(keyboardWidth("Home", 250, limits, false), 160);
  assert.equal(keyboardWidth("End", 250, limits, false), 360);
  assert.equal(keyboardWidth("ArrowUp", 250, limits, false), null);
  assert.equal(keyboardWidth("a", 250, limits, false), null);
});
