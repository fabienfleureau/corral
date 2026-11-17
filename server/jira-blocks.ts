// Delimited blocks Corral writes into a Jira description (see docs/adr/0001).
// A block is the nodes between two marker paragraphs; everything outside is the
// human's and is never touched. Jira stores descriptions as ADF, so the edit is
// done on the document tree, not on flattened text. A hash of the block as last
// written or seen detects a hand edit (or removed markers) before an overwrite.

import { createHash } from "node:crypto";

export type AdfNode = { type: string; text?: string; attrs?: Record<string, unknown>; content?: AdfNode[] };
export type AdfDoc = { type: "doc"; version: number; content: AdfNode[] };

export class BlockConflict extends Error {}

export const beginMarker = (name: string) => `[corral:begin:${name}]`;
export const endMarker = (name: string) => `[corral:end:${name}]`;

const emptyDoc = (): AdfDoc => ({ type: "doc", version: 1, content: [] });

function nodeText(n: AdfNode): string {
  return (n.text ?? "") + (n.content ?? []).map(nodeText).join("");
}

/** Accept what Jira returns for a description: an ADF doc, null, or (rarely) a string. */
export function asDoc(description: unknown): AdfDoc {
  if (description && typeof description === "object" && (description as AdfDoc).type === "doc") {
    return structuredClone(description as AdfDoc);
  }
  if (typeof description === "string" && description) return textToDoc(description);
  return emptyDoc();
}

/** Plain text → ADF: blank-line separated paragraphs, `## ` lines become headings. */
export function textToDoc(text: string): AdfDoc {
  const content: AdfNode[] = [];
  for (const chunk of text.trim().split(/\n{2,}/)) {
    const lines = chunk.split("\n");
    let para: string[] = [];
    const flush = () => {
      if (para.length) content.push({ type: "paragraph", content: para.flatMap((l, i) => (i ? [{ type: "hardBreak" }, { type: "text", text: l }] : [{ type: "text", text: l }])).filter((n) => n.type !== "text" || n.text) });
      para = [];
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        flush();
        content.push({ type: "heading", attrs: { level: Math.min(h[1].length + 1, 6) }, content: [{ type: "text", text: h[2] }] });
      } else para.push(line);
    }
    flush();
  }
  return { type: "doc", version: 1, content };
}

function find(doc: AdfDoc, name: string): { start: number; end: number } | null {
  const isP = (n: AdfNode, marker: string) => n.type === "paragraph" && nodeText(n).trim() === marker;
  const start = doc.content.findIndex((n) => isP(n, beginMarker(name)));
  if (start < 0) return null;
  const end = doc.content.findIndex((n, i) => i > start && isP(n, endMarker(name)));
  return end < 0 ? null : { start, end };
}

export function hasBlock(doc: AdfDoc, name: string): boolean {
  return find(doc, name) !== null;
}

/** Type, heading level, text and children only: Jira adds ids and attributes when it stores a document. */
function canonical(n: AdfNode): unknown {
  return [n.type, n.type === "heading" ? n.attrs?.level ?? null : null, n.text ?? null, (n.content ?? []).map(canonical)];
}

/** Hash of the block's content, or null when the markers are absent. */
export function blockHash(doc: AdfDoc, name: string): string | null {
  const at = find(doc, name);
  if (!at) return null;
  return createHash("sha1").update(JSON.stringify(doc.content.slice(at.start + 1, at.end).map(canonical))).digest("hex");
}

/** The document with the block set to `text`; appended at the end when it had none. */
export function setBlock(doc: AdfDoc, name: string, text: string): AdfDoc {
  const out = structuredClone(doc);
  const body = textToDoc(text).content;
  const at = find(out, name);
  const marker = (m: string): AdfNode => ({ type: "paragraph", content: [{ type: "text", text: m }] });
  if (at) out.content.splice(at.start + 1, at.end - at.start - 1, ...body);
  else out.content.push(marker(beginMarker(name)), ...body, marker(endMarker(name)));
  return out;
}

/**
 * The description to write, or a conflict. `lastHash` is the block's hash when
 * Corral last wrote it (null: never written). A block that changed since, that
 * lost its markers, or that appeared on its own, is not overwritten.
 */
export function planBlockWrite(description: unknown, name: string, text: string, lastHash: string | null): { doc: AdfDoc; hash: string } {
  const doc = asDoc(description);
  const current = blockHash(doc, name);
  if (lastHash === null && current !== null) throw new BlockConflict(`The ${name} block already exists in Jira and was not written by Corral. Remove or merge it by hand.`);
  if (lastHash !== null && current === null) throw new BlockConflict(`The ${name} block markers are gone from the Jira description. Restore them or clear the stored block.`);
  if (lastHash !== null && current !== lastHash) throw new BlockConflict(`The ${name} block was edited in Jira since Corral wrote it. Review the change, then retry.`);
  const next = setBlock(doc, name, text);
  return { doc: next, hash: blockHash(next, name)! };
}

/** Plain text of a description with every Corral block removed (what the task prompt should hold). */
export function stripBlocks(text: string): string {
  return text.replace(/^[ \t]*\[corral:begin:(\w+)\][\s\S]*?\[corral:end:\1\][ \t]*\n?/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
