// Google quota on the Usage page: CodexBar JSON parsing, CLI probing and cache.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleQuotaCache, emptyGoogleQuota, googleQuota, parseCodexBarQuota } from "../google-quota.ts";
import type { AgentQuota } from "../usage.ts";

const now = Date.parse("2026-11-21T12:00:00Z");

function geminiOutput(): string {
  return JSON.stringify([{
    provider: "gemini",
    source: "oauth-api",
    status: { description: "Operational" },
    usage: {
      updatedAt: new Date(now - 60_000).toISOString(),
      identity: { loginMethod: "Google AI Pro" },
      primary: { usedPercent: 64, windowMinutes: 1440, resetsAt: new Date(now + 3_600_000).toISOString() },
      secondary: { usedPercent: 38, windowMinutes: 1440, resetsAt: new Date(now + 10_800_000).toISOString() },
      tertiary: { usedPercent: 12, windowMinutes: 1440, resetsAt: new Date(now + 21_600_000).toISOString() },
    },
    rateWindowLabels: { primary: "Pro", secondary: "Flash", tertiary: "Flash Lite" },
  }]);
}

test("parseCodexBarQuota reads Gemini windows with their model-family labels", () => {
  const quota = parseCodexBarQuota([geminiOutput()], now);
  assert.equal(quota.agent, "google");
  assert.equal(quota.source, "CodexBar · Gemini");
  assert.equal(quota.plan, "Google AI Pro");
  assert.equal(quota.as_of_ms, now - 60_000);
  assert.equal(quota.stale, false);
  assert.deepEqual(quota.windows.map((w) => [w.label, w.used_percent]), [
    ["Pro", 64], ["Flash", 38], ["Flash Lite", 12],
  ]);
  assert.equal(quota.windows[0].resets_ms, now + 3_600_000);
  assert.equal(quota.note, null);
});

test("parseCodexBarQuota falls back to Antigravity's named model-family windows", () => {
  const output = JSON.stringify([{
    provider: "antigravity",
    usage: {
      updatedAt: new Date(now).toISOString(),
      extraRateWindows: [
        { id: "antigravity-quota-summary-gemini-weekly", title: "Gemini weekly", window: { usedPercent: 82, resetsAt: new Date(now + 86_400_000).toISOString() } },
        { id: "antigravity-quota-summary-3p-weekly", title: "Claude and GPT weekly", window: { usedPercent: 45, resetsAt: new Date(now + 86_400_000).toISOString() } },
      ],
    },
  }]);
  const quota = parseCodexBarQuota([JSON.stringify([{ provider: "gemini", error: { message: "not logged in" } }]), output], now);
  assert.equal(quota.source, "CodexBar · Antigravity");
  assert.deepEqual(quota.windows.map((w) => w.label), ["Gemini weekly", "Claude and GPT weekly"]);
  assert.equal(quota.note, null);
});

test("parseCodexBarQuota marks a snapshot stale after a window reset", () => {
  const output = JSON.stringify([{
    provider: "gemini",
    usage: { primary: { usedPercent: 90, resetsAt: new Date(now - 60_000).toISOString() } },
    rateWindowLabels: { primary: "Pro" },
  }]);
  const quota = parseCodexBarQuota([output], now);
  assert.equal(quota.stale, true);
  assert.equal(quota.windows.length, 1);
});

test("parseCodexBarQuota keeps the CLI's notes instead of inventing windows", () => {
  const outputs = [
    JSON.stringify([{ provider: "gemini", error: { message: "Gemini API error: not logged in" } }]),
    JSON.stringify([{ provider: "antigravity", error: { message: "Antigravity language server not detected." } }]),
  ];
  const quota = parseCodexBarQuota(outputs, now);
  assert.deepEqual(quota, emptyGoogleQuota("CodexBar: Gemini API error: not logged in · Antigravity language server not detected."));
  assert.deepEqual(parseCodexBarQuota(["not json", ""], now), emptyGoogleQuota("Enable Gemini or Antigravity in CodexBar to see Google quota here."));
});

test("parseCodexBarQuota ignores placeholders and out-of-range percentages", () => {
  const output = JSON.stringify([{
    provider: "gemini",
    usage: {
      primary: { usedPercent: 140, resetsAt: new Date(now + 3_600_000).toISOString() },
      secondary: { usedPercent: 20, isSyntheticPlaceholder: true },
    },
  }]);
  const quota = parseCodexBarQuota([output], now);
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0].used_percent, 100);
  assert.equal(quota.windows[0].label, "Window 1");
});

test("googleQuota probes both Google providers and survives a failed CLI", async () => {
  const calls: string[][] = [];
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args.includes("gemini")) return geminiOutput();
    throw new Error("exit 1");
  };
  const quota = await googleQuota({ run, executable: "/fake/codexbar", now });
  assert.equal(quota.windows.length, 3);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ["usage", "--provider", "gemini"],
    ["usage", "--provider", "antigravity"],
  ]);
  const missing = await googleQuota({ executable: null, now });
  assert.match(missing.note ?? "", /Install CodexBar/);
});

test("GoogleQuotaCache shares the CLI call and retries after a short failure pause", async () => {
  let calls = 0;
  let time = 0;
  const snapshot: AgentQuota = { ...emptyGoogleQuota(""), as_of_ms: 1, stale: false, plan: null, windows: [], note: null };
  const cache = new GoogleQuotaCache({ clock: () => time, fetchQuota: async () => { calls++; return snapshot; } });
  assert.deepEqual((await Promise.all([cache.get(), cache.get(), cache.get()])).map((q) => q.as_of_ms), [1, 1, 1]);
  assert.equal(calls, 1);
  time += 61_000;
  await cache.get();
  assert.equal(calls, 2);

  let failures = 0;
  const broken = new GoogleQuotaCache({ clock: () => time, fetchQuota: async () => { failures++; throw new Error("cli down"); } });
  assert.match((await broken.get()).note ?? "", /Could not reach/);
  await broken.get();
  assert.equal(failures, 1);
  time += 11_000;
  await broken.get();
  assert.equal(failures, 2);
});
