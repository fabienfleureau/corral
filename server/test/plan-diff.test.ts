// Unit tests for the dependency-free plan Markdown diff engine and revision-scoped draft store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLineWords, diffMarkdown } from "../../web/src/plan-diff.ts";
import {
  clearPlanDraft,
  loadPlanDraft,
  planDraftKey,
  savePlanDraft,
  type StorageLike,
} from "../../web/src/plan-draft.ts";

function memoryStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

test("diffMarkdown: identical revisions report identical=true with no segments", () => {
  const md = "## Contract\n\nPOST /orders returns 201.\n";
  const res = diffMarkdown(md, md);
  assert.equal(res.identical, true);
  assert.equal(res.added, 0);
  assert.equal(res.removed, 0);
  assert.equal(res.segments.length, 0);
});

test("diffMarkdown: line additions, deletions, unchanged context, and paired inline word highlights", () => {
  const v1 = [
    "## Contract",
    "",
    "POST /orders returns 201.",
    "No retries are defined.",
    "",
    "## Sub-tasks",
    "### 1. API",
  ].join("\n");
  const v2 = [
    "## Contract",
    "",
    "POST /orders returns 201 with Idempotency-Key.",
    "",
    "## Sub-tasks",
    "### 1. API",
    "### 2. Worker",
  ].join("\n");

  const res = diffMarkdown(v1, v2);
  assert.equal(res.identical, false);
  assert.equal(res.removed, 2);
  assert.equal(res.added, 2);

  const removedLine = res.lines.find((l) => l.type === "remove" && l.text.includes("POST /orders"));
  const addedLine = res.lines.find((l) => l.type === "add" && l.text.includes("Idempotency-Key"));
  assert.ok(removedLine, "removed line found");
  assert.ok(addedLine, "added line found");
  assert.ok(addedLine.spans?.some((s) => s.changed && s.text.includes("Idempotency-Key")), "inline word highlight marks added phrase");
  assert.ok(addedLine.spans?.some((s) => !s.changed && s.text.includes("POST /orders returns 201")), "unchanged prefix is not marked changed");

  const addedSubtask = res.lines.find((l) => l.type === "add" && l.text === "### 2. Worker");
  assert.ok(addedSubtask, "added subtask line present");
});

test("diffMarkdown: collapses long unchanged context runs", () => {
  const unchanged = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}`);
  const v1 = ["Header", ...unchanged, "Footer v1"].join("\n");
  const v2 = ["Header", ...unchanged, "Footer v2"].join("\n");
  const res = diffMarkdown(v1, v2, 2);
  assert.equal(res.identical, false);
  const collapsed = res.segments.filter((s) => s.kind === "collapsed");
  assert.equal(collapsed.length, 1);
  assert.ok(collapsed[0].lines.length >= 4);
});

test("diffLineWords: highlights only changed tokens", () => {
  const { oldSpans, newSpans } = diffLineWords("status is open", "status is done");
  assert.deepEqual(oldSpans.filter((s) => s.changed).map((s) => s.text), ["open"]);
  assert.deepEqual(newSpans.filter((s) => s.changed).map((s) => s.text), ["done"]);
});

test("planDraft: isolates drafts per (task_id, revision_id) and clears cleanly", () => {
  const storage = memoryStorage();
  savePlanDraft(storage, "task-1", "rev-1", {
    note: "Please add retries",
    comments: [{ id: "c1", revision_id: "rev-1", section: "Contract", repo: null, quote: "POST /x", body: "Add 409" }],
  });

  // Tab B on rev-2 sees an empty draft with zero bleed-over from rev-1.
  const rev2Draft = loadPlanDraft(storage, "task-1", "rev-2");
  assert.equal(rev2Draft.note, "");
  assert.deepEqual(rev2Draft.comments, []);

  // Tab A on rev-1 retains its draft intact.
  const rev1Draft = loadPlanDraft(storage, "task-1", "rev-1");
  assert.equal(rev1Draft.note, "Please add retries");
  assert.equal(rev1Draft.comments.length, 1);
  assert.equal(storage.store.has(planDraftKey("task-1", "rev-1")), true);

  clearPlanDraft(storage, "task-1", "rev-1");
  assert.equal(storage.store.has(planDraftKey("task-1", "rev-1")), false);
  assert.equal(loadPlanDraft(storage, "task-1", "rev-1").comments.length, 0);
});
