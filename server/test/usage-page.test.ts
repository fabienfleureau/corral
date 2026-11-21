// Regression: the Usage page used to render a single spinner until the whole
// report arrived. Every card must have a shell before any data is available.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const bundle = await build({
  stdin: { contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import { UsagePage } from "./web/src/pages/Usage.tsx"; export const render = () => renderToStaticMarkup(React.createElement(UsagePage));`, resolveDir: process.cwd(), loader: "jsx" },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
const module = { exports: {} as { render: () => string } };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { render } = module.exports;

test("Usage renders every card before quota and report data arrive", () => {
  const globals = globalThis as unknown as { window: unknown };
  const previous = globals.window;
  globals.window = { location: { hash: "#/usage" }, addEventListener() {}, removeEventListener() {} };
  try {
    const html = render();
    for (const heading of ["Quota", "Platform API", "Overview", "Over time", "By model", "Most expensive tasks", "Lines added"]) {
      assert.ok(html.includes(`>${heading}`), `missing heading ${heading}`);
    }
    for (const label of ["Claude", "Codex", "OpenCode Go", "Google", "GitHub API", "GitLab API", "Estimated cost", "Tokens", "Tasks per $", "Cost per done task"]) {
      assert.ok(html.includes(label), `missing card ${label}`);
    }
    assert.equal((html.match(/class="usage-card"/g) ?? []).length, 11, "all quota, platform and overview cards have a shell");
    assert.ok(html.includes('class="usage-grid usage-quota-grid"'), "quota cards use the dedicated 4-column grid");
    assert.equal((html.match(/class="usage-big">—<\/div>/g) ?? []).length, 5, "overview values start empty");
    assert.match(html, /Loading quota/);
    assert.match(html, /Loading rate limits/);
  } finally {
    globals.window = previous;
  }
});
