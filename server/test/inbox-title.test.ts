import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxTitle, itemDisplayTitle } from "../../web/src/inbox-title.ts";

test("inbox list identifies the source session and falls back to the report title", () => {
  const sessions = [{ address: "session-1", name: "Omnigent session" }, { address: "session-2", name: null }];
  assert.equal(inboxTitle({ source_ref: "session-1", title: "Question first line" }, sessions), "Omnigent session");
  assert.equal(inboxTitle({ source_ref: "session-2", title: "Report title" }, sessions), "Report title");
  assert.equal(inboxTitle({ source_ref: null, title: "No session" }, sessions), "No session");
});

test("inbox titles drop the gate status the row badge already shows", () => {
  const sessions: { address: string; name: string | null }[] = [];
  const title = (value: string) => inboxTitle({ source_ref: null, title: value }, sessions);
  assert.equal(title("PR ready for review: feat(search): rank by recency"), "feat(search): rank by recency");
  assert.equal(title("PR ready to merge: feat(search): rank by recency"), "feat(search): rank by recency");
  assert.equal(title("PR needs work: feat(search): rank by recency"), "feat(search): rank by recency");
  // Terminal states have no badge: their prefix is the only outcome shown.
  assert.equal(title("PR merged: feat(search): rank by recency"), "PR merged: feat(search): rank by recency");
  assert.equal(title("PR closed: feat(search): rank by recency"), "PR closed: feat(search): rank by recency");
  // A title that merely starts with "PR" is left alone.
  assert.equal(title("PR review comments need handling"), "PR review comments need handling");
});

test("display titles never repeat a status that is already a chip or badge", () => {
  assert.equal(
    itemDisplayTitle("PR ready for review: fix(delivery): surface sink delivery failures"),
    "fix(delivery): surface sink delivery failures",
  );
  assert.equal(itemDisplayTitle("PR merged: fix(delivery): surface sink delivery failures"), "PR merged: fix(delivery): surface sink delivery failures");
});
