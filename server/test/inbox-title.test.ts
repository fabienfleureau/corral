import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxTitle } from "../../web/src/inbox-title.ts";

test("inbox list identifies the source session and falls back to the report title", () => {
  const sessions = [{ address: "session-1", name: "Omnigent session" }, { address: "session-2", name: null }];
  assert.equal(inboxTitle({ source_ref: "session-1", title: "Question first line" }, sessions), "Omnigent session");
  assert.equal(inboxTitle({ source_ref: "session-2", title: "Report title" }, sessions), "Report title");
  assert.equal(inboxTitle({ source_ref: null, title: "No session" }, sessions), "No session");
});
