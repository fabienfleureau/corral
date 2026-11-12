import { test } from "node:test";
import assert from "node:assert/strict";
import { snoozeUntil } from "../../web/src/util.ts";

test("1h and 4h snoozes are offsets from now", () => {
  const before = Date.now();
  const oneHour = snoozeUntil("1h");
  const fourHours = snoozeUntil("4h");
  const after = Date.now();
  assert.ok(oneHour >= before + 3_600_000 && oneHour <= after + 3_600_000);
  assert.ok(fourHours >= before + 4 * 3_600_000 && fourHours <= after + 4 * 3_600_000);
});

test("tomorrow snoozes until 9am the next local day", () => {
  const now = new Date();
  const until = new Date(snoozeUntil("tomorrow"));
  const expected = new Date(now);
  expected.setHours(9, 0, 0, 0);
  expected.setDate(expected.getDate() + 1);
  assert.equal(until.getTime(), expected.getTime());
  assert.equal(until.getHours(), 9);
  assert.equal(until.getMinutes(), 0);
  assert.ok(until.getTime() > now.getTime());
});
