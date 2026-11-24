import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import {
  buildSidebarQuotaGauges,
  formatQuotaPrediction,
  formatResetIn,
  quotaAriaLabel,
  quotaPredictionDetail,
  quotaTone,
  remainingPercent,
} from "../../web/src/sidebar-quotas.ts";
import type { AgentQuota, QuotaPrediction } from "../../web/src/types.ts";
import { createHttpServer } from "../api.ts";
import { Db } from "../db.ts";
import { GoQuotaCache, UsageScanner, emptyGoQuota } from "../usage.ts";
import { GoogleQuotaCache, emptyGoogleQuota } from "../google-quota.ts";

const quota = (agent: AgentQuota["agent"], windows: AgentQuota["windows"], extra: Partial<AgentQuota> = {}): AgentQuota => ({
  agent,
  source: "test",
  as_of_ms: 1_700_000_000_000,
  stale: false,
  plan: null,
  windows,
  note: null,
  ...extra,
});

test("remainingPercent clamps out-of-range and non-finite values", () => {
  assert.equal(remainingPercent(0), 100);
  assert.equal(remainingPercent(25), 75);
  assert.equal(remainingPercent(100), 0);
  assert.equal(remainingPercent(140), 0);
  assert.equal(remainingPercent(-10), 100);
  assert.equal(remainingPercent(Number.NaN), 100);
});

test("quotaTone uses four tiers (ok < 50, caution 50..74, warn 75..89, hot >= 90)", () => {
  assert.equal(quotaTone(0), "ok");
  assert.equal(quotaTone(49.9), "ok");
  assert.equal(quotaTone(50), "caution");
  assert.equal(quotaTone(74.9), "caution");
  assert.equal(quotaTone(75), "warn");
  assert.equal(quotaTone(89.9), "warn");
  assert.equal(quotaTone(90), "hot");
  assert.equal(quotaTone(100), "hot");
});

test("rings show the two most-used windows, so a spent third window is not hidden", () => {
  // Live OpenCode Go shape: session and weekly untouched, monthly spent.
  const [gauge] = buildSidebarQuotaGauges([
    quota("opencode-go", [
      { label: "5-hour session", used_percent: 0, resets_ms: 1000 },
      { label: "Weekly", used_percent: 0, resets_ms: 2000 },
      { label: "Monthly", used_percent: 100, resets_ms: 3000 },
    ]),
  ]);
  assert.deepEqual(gauge.rings.map((r) => r.label), ["5-hour session", "Monthly"]);
  assert.equal(gauge.rings[1].tone, "hot");
  assert.equal(gauge.rings[1].remainingPercent, 0);
  assert.equal(gauge.windows.length, 3);
});

test("formatResetIn formats past, minutes, hours, and days", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatResetIn(null, now), "");
  assert.equal(formatResetIn(now - 1_000, now), "reset passed");
  assert.equal(formatResetIn(now + 12 * 60_000, now), "resets in 12m");
  assert.equal(formatResetIn(now + 2 * 3_600_000 + 15 * 60_000, now), "resets in 2h 15m");
  assert.equal(formatResetIn(now + 3 * 86_400_000, now), "resets in 3d");
});

test("buildSidebarQuotaGauges orders providers, skips empty ones, and caps concentric rings at 2", () => {
  const input: AgentQuota[] = [
    quota("google", []),
    quota("opencode-go", [
      { label: "5-hour session", used_percent: 100, resets_ms: 1000 },
      { label: "Weekly", used_percent: 0, resets_ms: 2000 },
      { label: "Monthly", used_percent: 15, resets_ms: 3000 },
    ]),
    quota("codex", [{ label: "5-hour", used_percent: 42, resets_ms: 1000 }], { plan: "Plus" }),
    quota("claude", [
      { label: "5-hour session", used_percent: 25, resets_ms: 1000 },
      { label: "Weekly (all models)", used_percent: 10, resets_ms: 2000 },
    ]),
  ];

  const gauges = buildSidebarQuotaGauges(input);
  assert.deepEqual(gauges.map((g) => g.agent), ["claude", "codex", "opencode-go"]);
  assert.equal(gauges[0].rings.length, 2);
  assert.equal(gauges[0].rings[0].remainingPercent, 75);
  assert.equal(gauges[0].rings[1].remainingPercent, 90);
  assert.equal(gauges[1].rings.length, 1);
  assert.equal(gauges[1].rings[0].remainingPercent, 58);
  assert.equal(gauges[1].plan, "Plus");
  assert.equal(gauges[2].rings.length, 2);
  assert.equal(gauges[2].windows.length, 3);
  assert.deepEqual(gauges[2].rings.map((r) => r.label), ["5-hour session", "Monthly"]);
  assert.equal(gauges[2].rings[0].tone, "hot");
  assert.equal(gauges[2].rings[1].tone, "ok");

  assert.match(quotaAriaLabel(gauges[0]), /Claude quota: 5-hour session 75% left, Weekly \(all models\) 90% left/);
});

test("SidebarQuotas renders concentric progress rings and provider marks", async () => {
  const bundled = await build({
    stdin: {
      contents: `
        import React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { SidebarQuotas } from "./web/src/SidebarQuotas.tsx";
        export const render = (quotas) => renderToStaticMarkup(React.createElement(SidebarQuotas, { quotas, onOpenUsage: () => {} }));
      `,
      resolveDir: process.cwd(),
      loader: "jsx",
    },
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
  });
  const mod = { exports: {} as { render: (quotas: AgentQuota[] | null) => string } };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  assert.equal(mod.exports.render(null), "");
  const html: string = mod.exports.render([
    quota("claude", [
      { label: "5-hour session", used_percent: 25, resets_ms: null },
      { label: "Weekly", used_percent: 5, resets_ms: null },
    ]),
    quota("codex", [{ label: "5-hour", used_percent: 75, resets_ms: null }]),
    quota("opencode-go", [{ label: "Monthly", used_percent: 60, resets_ms: null }]),
    quota("google", [{ label: "5-hour", used_percent: 100, resets_ms: null }]),
  ]);
  assert.match(html, /class="sidebar-quotas"/);
  assert.match(html, /class="quota-rings-svg"/);
  assert.match(html, /quota-ring-outer quota-ring-ok" data-remaining="75"/);
  assert.match(html, /quota-ring-inner quota-ring-ok" data-remaining="95"/);
  assert.match(html, /quota-ring-outer quota-ring-warn" data-remaining="25"/);
  assert.match(html, /quota-ring-outer quota-ring-caution" data-remaining="40"/);
  assert.match(html, /quota-ring-outer quota-ring-hot quota-ring-exhausted" data-remaining="0"/);
  assert.match(html, /stroke-linecap="round"/);
  assert.match(html, /quota-ring-arc quota-ring-empty/);
  assert.doesNotMatch(html, /sidebar-quota-alert/);

  const withAlert = mod.exports.render([
    quota("claude", [
      {
        label: "Weekly",
        used_percent: 70,
        resets_ms: null,
        prediction: { will_hit: true, status: "will_hit", projected_percent: 120, hits_in_ms: 36 * 3_600_000, hits_at_ms: 100, rate_per_day: 20, basis: "curve" },
      },
    ]),
  ]);
  assert.match(withAlert, /sidebar-quota-alert/);
});

test("formatQuotaPrediction, quotaPredictionDetail, willHit, and quotaAriaLabel handle predictions", () => {
  const pred = (over: Partial<QuotaPrediction>): QuotaPrediction => ({
    will_hit: false,
    status: "safe",
    projected_percent: 42,
    hits_in_ms: null,
    hits_at_ms: null,
    rate_per_day: 6,
    basis: "curve",
    ...over,
  });
  assert.equal(formatQuotaPrediction(pred({})), "On track · ~42% by reset");
  assert.equal(formatQuotaPrediction(pred({ status: "close", projected_percent: 91 })), "Close · ~91% by reset");
  assert.equal(formatQuotaPrediction(pred({ status: "will_hit", will_hit: true, projected_percent: 135, hits_in_ms: 30 * 3_600_000 })), "Hits in ~1d 6h (~135% pace)");
  assert.equal(formatQuotaPrediction(pred({ status: "will_hit", will_hit: true, projected_percent: 450, hits_in_ms: 5 * 3_600_000 })), "Hits in ~5h (>300% pace)");
  assert.equal(formatQuotaPrediction(pred({ status: "hit", will_hit: true, projected_percent: 100 })), "Limit hit (100%)");
  assert.match(quotaPredictionDetail(pred({})), /based on current usage curve/);
  assert.match(quotaPredictionDetail(pred({ basis: "pace" })), /based on window pace/);

  const [gauge] = buildSidebarQuotaGauges([
    quota("codex", [
      { label: "5-hour", used_percent: 20, resets_ms: 1000, prediction: null },
      { label: "Weekly", used_percent: 70, resets_ms: 2000, prediction: pred({ status: "will_hit", will_hit: true, projected_percent: 125, hits_in_ms: 48 * 3_600_000 }) },
    ]),
  ]);
  assert.equal(gauge.willHit, true);
  assert.match(quotaAriaLabel(gauge), /Hits in ~2d \(~125% pace\)/);
});

test("GET /api/usage/quota scans Codex session logs on first call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-sidebar-quota-"));
  const codexDir = join(dir, "codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, "rollout.jsonl"),
    JSON.stringify({
      type: "event_msg",
      timestamp: new Date().toISOString(),
      payload: {
        type: "token_count",
        rate_limits: {
          plan_type: "Plus",
          primary: { used_percent: 33, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        },
      },
    }) + "\n",
  );
  const db = new Db(join(dir, "corral.db"));
  const server = createHttpServer({
    db,
    cfg: { token: "test", port: 0, host: "127.0.0.1", agents: {}, assistant: [], workspaceRoots: [], omnigent: { baseUrl: "" }, jira: { baseUrl: "", email: "", token: "", jql: "" } } as never,
    backend: { name: "test", list: async () => [], spawn: async () => ({ address: "a" }), send: async () => {}, kill: async () => {}, screen: async () => "" } as never,
    jira: { configured: false } as never,
    capture: {} as never,
    hub: { emit() {}, subscribe() { return () => {}; } } as never,
    usage: new UsageScanner({ claudeDir: join(dir, "claude"), codexDir, claudeQuotaDir: join(dir, "cc") }),
    goQuota: new GoQuotaCache({ fetchQuota: async () => emptyGoQuota("none") }),
    googleQuota: new GoogleQuotaCache({ fetchQuota: async () => emptyGoogleQuota("none") }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/usage/quota`, {
      headers: { Authorization: "Bearer test" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { quota: AgentQuota[] };
    const codex = body.quota.find((q) => q.agent === "codex");
    assert.ok(codex);
    assert.equal(codex.plan, "Plus");
    assert.equal(codex.windows.length, 1);
    assert.equal(codex.windows[0].used_percent, 33);
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
