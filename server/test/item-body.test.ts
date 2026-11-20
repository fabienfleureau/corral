import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const bundle = await build({
  stdin: { contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import { ItemBody } from "./web/src/item-body.tsx"; export const render = item => renderToStaticMarkup(React.createElement(ItemBody, { item }));`, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, platform: "node", format: "cjs", write: false,
});
const module = { exports: {} as { render: (item: Record<string, unknown>) => string } };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { render } = module.exports;

test("auto-captured item bodies render Markdown instead of raw code", () => {
  const html = render({
    kind: "question",
    structured: 0,
    summary: "",
    body: "**Evidence checks out** (snapshot): 30d = 202 failed / 3112.\n\n- Qovery-side failures explain the gap\n- The engine root cause is unknown\n\nReview the [evidence](https://example.com/evidence).",
  });
  assert.match(html, /<strong>Evidence checks out<\/strong>/);
  assert.match(html, /<ul><li>/);
  assert.match(html, /<a href="https:\/\/example.com\/evidence"/);
  assert.doesNotMatch(html, /body-raw/);
  assert.doesNotMatch(html, /\*\*Evidence/);
});

test("an auto-captured summary is Markdown above the Markdown body", () => {
  const html = render({ kind: "question", structured: 0, summary: "**Needs you**", body: "Reply to continue." });
  assert.match(html, /<strong>Needs you<\/strong>/);
  assert.match(html, /Reply to continue\./);
});

test("structured PR items keep hiding the gate summary in the body", () => {
  const html = render({ kind: "pr", structured: 1, summary: "ready for review", body: "## Why\n\nRecent results are buried." });
  assert.doesNotMatch(html, /ready for review/);
  assert.match(html, /<h3>Why<\/h3>/);
});
