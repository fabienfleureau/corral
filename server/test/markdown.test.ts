import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const bundle = await build({
  stdin: { contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import { Markdown } from "./web/src/markdown.tsx"; export const render = text => renderToStaticMarkup(React.createElement(Markdown, { text }));`, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true, platform: "node", format: "cjs", write: false,
});
const module = { exports: {} as { render: (text: string) => string } };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { render } = module.exports;

test("renders PR review guides as disclosures with formatted summaries and markdown content", () => {
  const html = render('<details><summary>🗺️ <b>Review guide</b> · check</summary>\n\n1. [File](https://example.com)\n\n</details>');
  assert.match(html, /<details><summary>🗺️ <strong>Review guide<\/strong> · check<\/summary>/);
  assert.match(html, /<ol><li>.*<a href="https:\/\/example.com"/);
  assert.doesNotMatch(html, /&lt;\/details&gt;/);
});

test("renders safe screenshot images and rejects unsafe image URLs", () => {
  const html = render('![Before](https://example.com/before.png)\n\n![Unsafe](javascript:alert)');
  assert.match(html, /<img[^>]*src="https:\/\/example.com\/before.png"[^>]*alt="Before"|<img[^>]*alt="Before"[^>]*src="https:\/\/example.com\/before.png"/);
  assert.doesNotMatch(html, /src="javascript:/);
});

test("absolute Markdown paths become viewer buttons in prose and inline code", () => {
  const path = "/Users/ffleureau/workspace/qovery/e2e-custom-domains-org-list.md";
  const plain = render(`Read ${path} first.`);
  assert.ok(plain.includes(`<button type="button" class="md-file-link" title="Open ${path}">${path}</button>`));
  const code = render(`Read \`${path}\` first.`);
  assert.match(code, /class="md-file-link md-file-code"/);
});

test("URLs and other file extensions are not turned into local file buttons", () => {
  const html = render("https://example.com/notes.md and /tmp/notes.txt");
  assert.match(html, /<a href="https:\/\/example.com\/notes.md"/);
  assert.doesNotMatch(html, /md-file-link/);
});
