import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewers } from "../reviewers.ts";

test("reviewers parse, trim and reject malformed input", () => {
  assert.deepEqual(
    parseReviewers([{ name: " cubic ", command: " cubic review --json " }]),
    [{ name: "cubic", command: "cubic review --json" }],
  );
  assert.deepEqual(parseReviewers([]), []);
  assert.throws(() => parseReviewers("not-an-array"));
  assert.throws(() => parseReviewers([{ name: "cubic" }]));
  assert.throws(() => parseReviewers([{ name: "cubic", command: "" }]));
  assert.throws(() => parseReviewers([{ name: " ", command: "cubic review" }]));
  assert.throws(() => parseReviewers([{ name: "cubic", command: 42 }]));
});

test("reviewer names must be unique", () => {
  assert.throws(() =>
    parseReviewers([
      { name: "cubic", command: "cubic review" },
      { name: "cubic", command: "other" },
    ]),
  );
});
