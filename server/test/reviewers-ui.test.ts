// The reviewers form and pickers: a delegate reviewer must survive an edit, and
// a picker must not offer one where the server would refuse it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { delegateConflict } from "../reviewers.ts";
import {
  EMPTY_REVIEWER_DRAFT,
  draftToReviewer,
  reviewerBlocked,
  reviewerOptionLabel,
  reviewerSummary,
  reviewerToDraft,
} from "../../web/src/reviewers.ts";
import type { Reviewer } from "../../web/src/types.ts";

const COMMAND: Reviewer = { name: "cubic", command: "cubic review --base {base_branch} --json" };
const CODEX: Reviewer = { name: "ocr-codex", delegate: "codex" };

test("editing a reviewer round-trips both shapes without losing or inventing a field", () => {
  assert.deepEqual(draftToReviewer(reviewerToDraft(COMMAND)), COMMAND);
  assert.deepEqual(draftToReviewer(reviewerToDraft(CODEX)), CODEX);
  // A delegate carries no command, even when the draft still holds the text of an earlier one.
  assert.deepEqual(draftToReviewer({ name: " ocr-claude ", kind: "claude", command: "left over" }), { name: "ocr-claude", delegate: "claude" });
});

test("a draft is incomplete without a name, or a command for the command kind", () => {
  assert.equal(draftToReviewer(EMPTY_REVIEWER_DRAFT), null);
  assert.equal(draftToReviewer({ name: "x", kind: "command", command: "  " }), null);
  assert.equal(draftToReviewer({ name: "  ", kind: "codex", command: "" }), null);
  assert.deepEqual(draftToReviewer({ name: "x", kind: "codex", command: "" }), { name: "x", delegate: "codex" });
});

test("the summary shows the command, or says which sub-agent takes the review", () => {
  assert.equal(reviewerSummary(COMMAND), COMMAND.command);
  assert.equal(reviewerSummary(CODEX), "Hands the review to a Codex sub-agent");
  assert.equal(reviewerSummary({ name: "ocr-claude", delegate: "claude" }), "Hands the review to a Claude sub-agent");
});

test("a picker blocks a delegate exactly where the server refuses it", () => {
  for (const harness of ["claude", "codex", "opencode"]) {
    for (const agent of ["", "my-agent"]) {
      assert.equal(reviewerBlocked(CODEX, harness, agent), delegateConflict({ name: "ocr-codex", delegate: "codex" }, harness, agent) !== null, `${harness}/${agent}`);
      assert.equal(reviewerBlocked(COMMAND, harness, agent), false, "a command reviewer runs anywhere");
    }
  }
  assert.equal(reviewerOptionLabel(CODEX, "claude", ""), "ocr-codex");
  assert.equal(reviewerOptionLabel(CODEX, "codex", ""), "ocr-codex (needs Claude, no agent)");
  assert.equal(reviewerOptionLabel(COMMAND, "codex", "my-agent"), "cubic");
});
