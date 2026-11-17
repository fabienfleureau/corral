// Jira write-back: Corral replaces only its own delimited block of an ADF
// description, and refuses to overwrite one that was edited, lost its markers,
// or appeared on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BlockConflict, asDoc, blockHash, hasBlock, planBlockWrite, setBlock, stripBlocks, type AdfDoc } from "../jira-blocks.ts";

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const human: AdfDoc = { type: "doc", version: 1, content: [para("Goal"), { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Why" }] }, para("Because.")] };

test("a first write appends the block and leaves the rest of the document untouched", () => {
  const { doc, hash } = planBlockWrite(human, "design", "## Design v2\n\nUse REST.", null);
  assert.deepEqual(doc.content.slice(0, 3), human.content);
  assert.equal(hasBlock(doc, "design"), true);
  assert.equal(blockHash(doc, "design"), hash);
  assert.equal(doc.content.at(-1)!.content![0].text, "[corral:end:design]");
});

test("a rewrite replaces the block, keeps what a human wrote around it, and holds one version only", () => {
  const first = planBlockWrite(human, "design", "## Design v2\n\nA", null);
  const withNote: AdfDoc = { ...first.doc, content: [...first.doc.content, para("Human note after")] };
  const second = planBlockWrite(withNote, "design", "## Design v3\n\nB", first.hash);
  const text = JSON.stringify(second.doc);
  assert.ok(text.includes("Design v3") && !text.includes("Design v2"), "the old version is gone");
  assert.ok(text.includes("Human note after") && text.includes("Because."));
  assert.equal(JSON.stringify(second.doc).split("[corral:begin:design]").length - 1, 1, "one block");
});

test("conflicts: edited block, removed markers, or a block Corral never wrote", () => {
  const first = planBlockWrite(human, "design", "## Design v2\n\nA", null);
  const edited = structuredClone(first.doc);
  const at = edited.content.findIndex((n) => n.content?.[0]?.text === "[corral:begin:design]");
  edited.content[at + 1].content![0].text = "Edited in Jira";
  assert.throws(() => planBlockWrite(edited, "design", "x", first.hash), BlockConflict);
  assert.throws(() => planBlockWrite(human, "design", "x", first.hash), /markers are gone/);
  assert.throws(() => planBlockWrite(first.doc, "design", "x", null), /not written by Corral/);
});

test("the hash ignores attributes Jira adds when it stores the document", () => {
  const first = planBlockWrite(human, "amendment", "## Amendment\n\nDo X", null);
  const stored = structuredClone(first.doc);
  for (const n of stored.content) n.attrs = { ...n.attrs, localId: "abc" };
  assert.doesNotThrow(() => planBlockWrite(stored, "amendment", "y", first.hash));
});

test("two blocks do not interfere; text and string descriptions are accepted", () => {
  const a = setBlock(asDoc("Plain text description"), "design", "D");
  const b = setBlock(a, "amendment", "A");
  assert.equal(hasBlock(b, "design"), true);
  assert.equal(hasBlock(b, "amendment"), true);
  assert.notEqual(blockHash(b, "design"), blockHash(b, "amendment"));
  assert.equal(asDoc(null).content.length, 0);
});

test("stripBlocks removes a block from plain text and keeps the rest", () => {
  const text = "Goal\n\n[corral:begin:design]\n## Design v2\nUse REST.\n[corral:end:design]\n\nMore";
  assert.equal(stripBlocks(text), "Goal\n\nMore");
});
