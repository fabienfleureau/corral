import assert from "node:assert/strict";
import { test } from "node:test";
import { taskRef } from "../../shared/task-id.ts";

const UUID = "17fe4aac-2b41-4b08-ad78-b46ff0fe156e";

test("a task reference is the start of its full id", () => {
  assert.equal(taskRef(UUID), "17fe4aac");
  assert.ok(UUID.startsWith(taskRef(UUID)));
});

test("short ids keep their prefix", () => {
  assert.equal(taskRef("abc"), "abc");
  assert.equal(taskRef(""), "");
});
