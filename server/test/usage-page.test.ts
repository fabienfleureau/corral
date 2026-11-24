// Regression: the Usage page used to render a single spinner until the whole
// report arrived. Every card must have a shell before any data is available.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const bundle = await build({
  stdin: {
    contents: `import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import { UsagePage, formatUsageWindow } from "./web/src/pages/Usage.tsx"; export const render = () => renderToStaticMarkup(React.createElement(UsagePage)); export { formatUsageWindow };`,
    resolveDir: process.cwd(),
    loader: "jsx",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
});
const module = {
  exports: {} as {
    render: () => string;
    formatUsageWindow: (
      range: "24h" | "7d" | "30d" | "all",
      report: { range: "24h" | "7d" | "30d" | "all"; since_ms: number | null; generated_ms: number; timeline: { start_ms: number }[] } | null,
      locale?: string,
    ) => { dates: string | null; label: string; tooltip?: string };
  },
};
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { render, formatUsageWindow } = module.exports;

function renderWithHash(hash: string): string {
  const globals = globalThis as unknown as { window: unknown };
  const previous = globals.window;
  globals.window = { location: { hash }, addEventListener() {}, removeEventListener() {} };
  try {
    return render();
  } finally {
    globals.window = previous;
  }
}

test("Usage renders every card before quota and report data arrive", () => {
  const html = renderWithHash("#/usage");
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
});

test("Usage timeframe selector sits on Overview and cards declare their scope", () => {
  const html7d = renderWithHash("#/usage");
  const platformIdx = html7d.indexOf(">Platform API<");
  const overviewIdx = html7d.indexOf(">Overview<");
  const selectorIdx = html7d.indexOf('aria-label="Usage timeframe"');
  const overTimeIdx = html7d.indexOf(">Over time<");
  assert.ok(platformIdx < overviewIdx && overviewIdx < selectorIdx && selectorIdx < overTimeIdx, "timeframe selector lives in Overview header");
  assert.ok(html7d.includes('role="group" aria-label="Usage timeframe"'));
  assert.ok(html7d.includes('class="chip chip-active" aria-pressed="true">Last 7 days</button>'));
  assert.equal((html7d.match(/class="badge">Last 7d<\/span>/g) ?? []).length, 4, "4 ranged Overview cards show Last 7d badge");
  assert.equal((html7d.match(/class="badge badge-warn"[^>]*>All time<\/span>/g) ?? []).length, 2, "Lines added card and section highlight All time mismatch");

  const estIdx = html7d.indexOf("Estimated cost");
  const tokensIdx = html7d.indexOf("Tokens", estIdx);
  const tpdIdx = html7d.indexOf("Tasks per $", tokensIdx);
  const cpdIdx = html7d.indexOf("Cost per done task", tpdIdx);
  const linesIdx = html7d.indexOf("Lines added in PRs / MRs", cpdIdx);
  assert.ok(estIdx < tokensIdx && tokensIdx < tpdIdx && tpdIdx < cpdIdx && cpdIdx < linesIdx, "Lines added card appears after the 4 ranged cards");

  const html24h = renderWithHash("#/usage?range=24h");
  assert.ok(html24h.includes('class="chip chip-active" aria-pressed="true">Last 24 hours</button>'));
  assert.equal((html24h.match(/class="badge">Last 24h<\/span>/g) ?? []).length, 4, "24h range updates card badges");

  const htmlAll = renderWithHash("#/usage?range=all");
  assert.ok(htmlAll.includes('class="chip chip-active" aria-pressed="true">All time</button>'));
  assert.equal((htmlAll.match(/badge-warn/g) ?? []).length, 0, "All time selection does not highlight All time cards as a mismatch");
});

test("formatUsageWindow formats ranges and guards missing or stale reports", () => {
  assert.deepEqual(formatUsageWindow("7d", null, "en-US"), { dates: null, label: "Last 7 days" });
  const end = Date.UTC(2026, 10, 24, 15, 20);
  const stale = formatUsageWindow("30d", { range: "7d", since_ms: end - 7 * 86_400_000, generated_ms: end, timeline: [] }, "en-US");
  assert.deepEqual(stale, { dates: null, label: "Last 30 days" });

  const win24h = formatUsageWindow("24h", { range: "24h", since_ms: end - 86_400_000, generated_ms: end, timeline: [] }, "en-US");
  assert.ok(win24h.dates && win24h.dates.includes(":"), `24h window includes time: ${win24h.dates}`);
  assert.ok(win24h.label.startsWith("Last 24 hours · "));
  assert.ok(win24h.tooltip?.includes("–"));

  const win7d = formatUsageWindow("7d", { range: "7d", since_ms: Date.UTC(2026, 10, 17, 15, 20), generated_ms: end, timeline: [] }, "en-US");
  assert.ok(win7d.dates && !win7d.dates.includes("2026"), `same-year 7d omits year: ${win7d.dates}`);
  assert.ok(win7d.label.startsWith("Last 7 days · "));

  const crossYear = formatUsageWindow("30d", { range: "30d", since_ms: Date.UTC(2025, 11, 20, 12, 0), generated_ms: end, timeline: [] }, "en-US");
  assert.ok(crossYear.dates?.includes("2025") && crossYear.dates?.includes("2026"), `cross-year includes both years: ${crossYear.dates}`);

  const allWithData = formatUsageWindow("all", { range: "all", since_ms: null, generated_ms: end, timeline: [{ start_ms: Date.UTC(2026, 9, 1, 0, 0) }] }, "en-US");
  assert.ok(allWithData.dates !== null && allWithData.label.startsWith("All time · "));

  const allEmpty = formatUsageWindow("all", { range: "all", since_ms: null, generated_ms: end, timeline: [] }, "en-US");
  assert.deepEqual(allEmpty, { dates: null, label: "All time" });

  const inverted = formatUsageWindow("all", { range: "all", since_ms: null, generated_ms: end, timeline: [{ start_ms: end + 1000 }] }, "en-US");
  assert.deepEqual(inverted, { dates: null, label: "All time" });
});
