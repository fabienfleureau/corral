import { test } from "node:test";
import assert from "node:assert/strict";
import { delegateAgentName, delegateConflict, isDelegateReviewer, parseReviewers } from "../reviewers.ts";

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

test("a delegate reviewer parses next to command reviewers", () => {
  const parsed = parseReviewers([
    { name: "cubic", command: "cubic review" },
    { name: " ocr-codex ", delegate: "codex" },
    { name: "ocr-claude", delegate: "claude", command: "" },
  ]);
  assert.deepEqual(parsed, [
    { name: "cubic", command: "cubic review" },
    { name: "ocr-codex", delegate: "codex" },
    { name: "ocr-claude", delegate: "claude" },
  ]);
  assert.deepEqual(parsed.map(isDelegateReviewer), [false, true, true]);
  assert.equal(delegateAgentName({ name: "x", delegate: "codex" }), "ocr_codex");
});

test("a reviewer is a command or a delegate, never both and never neither", () => {
  assert.throws(() => parseReviewers([{ name: "x", command: "run", delegate: "codex" }]), /both a command and a delegate/);
  assert.throws(() => parseReviewers([{ name: "x" }]), /command or a delegate/);
  assert.throws(() => parseReviewers([{ name: "x", delegate: "opencode" }]), /Unknown delegate harness/);
  assert.throws(() => parseReviewers([{ name: "x", delegate: 7 }]), /Unknown delegate harness/);
  assert.throws(() => parseReviewers([{ name: "x", command: 7, delegate: "codex" }]), /command must be a string/);
});

test("a delegate reviewer needs the claude harness and no explicit agent", () => {
  const delegate = { name: "ocr-codex", delegate: "codex" } as const;
  assert.equal(delegateConflict(delegate, "claude", null), null);
  assert.equal(delegateConflict(delegate, "claude", undefined), null);
  assert.match(delegateConflict(delegate, "codex", null) ?? "", /claude harness \(got codex\)/);
  assert.match(delegateConflict(delegate, "claude", "agent-1") ?? "", /explicit agent/);
  // A command reviewer has no such limits.
  assert.equal(delegateConflict({ name: "cubic", command: "cubic" }, "codex", "agent-1"), null);
});
