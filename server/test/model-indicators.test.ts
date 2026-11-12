import { test } from "node:test";
import assert from "node:assert/strict";
import { modelFactsReport } from "../../web/src/model-indicators.ts";
import type { ModelCatalog } from "../../web/src/types.ts";

const catalog: ModelCatalog = {
  "opus": {
    retention: "none",
    efforts: { high: { index: 52, costPerTask: 3.46, minPerTask: 9.5 }, default: { index: 35, costPerTask: 0.98 } },
    bench: { "Terminal-Bench 4.0": 66.4 },
    asOf: "2026-11-11",
    source: "Artificial Analysis Intelligence Index v5.0.1",
  },
  "opencode-go/beam-free": {
    retention: "30d",
    quota: { monthlyUsd: 20 },
    efforts: { default: { index: 18, costPerTask: 0.28, minPerTask: 2 } },
    asOf: "2026-11-11",
  },
  "ornith-local/ornith-1.5-35b-a3b": { retention: "none", asOf: "2026-11-11" },
};

const claude = { harness: "claude", models: [{ id: "opus" }, { id: "sonnet" }] };
const opencode = { harness: "opencode", models: [{ id: "opencode-go/beam-free" }] };
const unlisted = { harness: "pi", models: [] };

const value = (report: ReturnType<typeof modelFactsReport>, key: string) => report.indicators.find((row) => row.key === key)?.value;

test("a model with no catalog entry shows no data and still reports availability", () => {
  const report = modelFactsReport({
    selection: { harness: "codex", model: "gpt-5.4", reasoning: "high" },
    catalog,
    harnesses: [{ harness: "codex", models: [{ id: "gpt-6.1-sol" }] }],
    context: "professional",
  });
  assert.equal(report.hasFacts, false);
  assert.equal(report.summary, "no data");
  assert.equal(report.retention, null);
  assert.equal(value(report, "facts"), "no data");
  assert.equal(value(report, "availability"), "unavailable");
  assert.deepEqual(report.indicators.map((row) => row.key), ["facts", "availability", "quota"]);
  assert.deepEqual(report.warnings, []);
});

test("quality, cost, speed, retention and asOf come from the matching effort", () => {
  const report = modelFactsReport({
    selection: { harness: "claude", model: "opus", reasoning: "high" },
    catalog,
    harnesses: [claude],
    context: "professional",
  });
  assert.equal(report.hasFacts, true);
  assert.equal(report.summary, "52 index · $3.46/task");
  assert.equal(report.retention, "none");
  assert.equal(value(report, "quality"), "52 index");
  assert.equal(value(report, "cost"), "$3.46/task");
  assert.equal(value(report, "speed"), "9.5 min/task");
  assert.equal(value(report, "retention"), "none");
  assert.equal(value(report, "asOf"), "2026-11-11");
  // Bench scores and the monthly plan limit are context, not headline numbers.
  assert.match(report.indicators.find((row) => row.key === "quality")?.hint ?? "", /Terminal-Bench 4\.0 66\.4/);
  assert.equal(report.warnings.length, 0);
  assert.match(report.title, /Quality: 52 index/);
});

test("the monthly plan limit explains the cost when the model has one", () => {
  const report = modelFactsReport({
    selection: { harness: "opencode", model: "opencode-go/beam-free", reasoning: "" },
    catalog,
    harnesses: [opencode],
    context: "personal",
  });
  assert.equal(value(report, "cost"), "$0.28/task");
  assert.match(report.indicators.find((row) => row.key === "cost")?.hint ?? "", /\$20\.00 monthly plan limit/);
  assert.equal(value(report, "retention"), "30 days");
  // Personal work: retention is shown, not warned about.
  assert.deepEqual(report.warnings, []);
});

test("professional work warns on retention and on a non-Claude/ChatGPT harness", () => {
  const report = modelFactsReport({
    selection: { harness: "opencode", model: "opencode-go/beam-free", reasoning: "" },
    catalog,
    harnesses: [opencode],
    context: "professional",
  });
  assert.deepEqual(report.warnings.map((warning) => warning.key), ["retention", "harness"]);
  assert.match(report.warnings[0].message, /not cleared for professional work/);
  assert.match(report.warnings[0].message, /still goes through/);
  assert.match(report.warnings[1].message, /only cleared on claude and codex/);
  assert.match(report.title, /⚠/);
});

test("a professional Claude choice has no warnings; an unknown context shows none either", () => {
  const selection = { harness: "claude", model: "opus", reasoning: "high" };
  assert.deepEqual(modelFactsReport({ selection, catalog, harnesses: [claude], context: "professional" }).warnings, []);
  assert.deepEqual(modelFactsReport({ selection, catalog, harnesses: [claude], context: null }).warnings, []);
  const unknownRetention = modelFactsReport({
    selection: { harness: "claude", model: "opus", reasoning: "high" },
    catalog: { "opus": { ...catalog.opus, retention: "unknown" } },
    harnesses: [claude],
    context: "professional",
  });
  assert.deepEqual(unknownRetention.warnings.map((warning) => warning.key), ["retention"]);
});

test("quota left comes from the AgentQuota snapshot, or says unknown", () => {
  const quota = [{
    agent: "claude" as const,
    source: "~/.cache/ccstatusline",
    as_of_ms: 1,
    stale: false,
    plan: "Max",
    windows: [{ label: "5h", used_percent: 40, resets_ms: null }, { label: "7d", used_percent: 92.4, resets_ms: null }],
    note: null,
  }];
  const present = modelFactsReport({ selection: { harness: "claude", model: "opus", reasoning: "high" }, catalog, quota, harnesses: [claude], context: "personal" });
  assert.equal(value(present, "quota"), "5h 60% left · 7d 8% left");

  const absent = modelFactsReport({ selection: { harness: "claude", model: "opus", reasoning: "high" }, catalog, harnesses: [claude], context: "personal" });
  assert.equal(value(absent, "quota"), "unknown");

  const stale = modelFactsReport({ selection: { harness: "codex", model: "opus", reasoning: "high" }, catalog, quota: [{ ...quota[0], agent: "codex", stale: true }], harnesses: [claude], context: "personal" });
  assert.match(stale.indicators.find((row) => row.key === "quota")?.hint ?? "", /stale/);

  // Other harnesses have no quota concept in Corral.
  const other = modelFactsReport({ selection: { harness: "opencode", model: "opencode-go/beam-free", reasoning: "" }, catalog, quota, harnesses: [opencode], context: "personal" });
  assert.equal(value(other, "quota"), undefined);
});

test("availability says available, unavailable, or unknown — never down by guess", () => {
  const available = modelFactsReport({ selection: { harness: "claude", model: "opus", reasoning: "" }, catalog, harnesses: [claude], context: "personal" });
  assert.equal(value(available, "availability"), "available");

  const notListed = modelFactsReport({ selection: { harness: "claude", model: "haiku", reasoning: "" }, catalog, harnesses: [claude], context: "personal" });
  assert.equal(value(notListed, "availability"), "unavailable");

  // Harness does not report a model catalog: nothing is claimed.
  const unknown = modelFactsReport({ selection: { harness: "pi", model: "opencode-go/beam-free", reasoning: "" }, catalog, harnesses: [unlisted], context: "personal" });
  assert.equal(value(unknown, "availability"), "unknown");

  const missingHarness = modelFactsReport({ selection: { harness: "junie", model: "opus", reasoning: "" }, catalog, harnesses: [claude], context: "personal" });
  assert.equal(value(missingHarness, "availability"), "unavailable");

  const pinnedDefault = modelFactsReport({ selection: { harness: "claude", model: "", reasoning: "" }, catalog, harnesses: [claude], context: "personal" });
  assert.equal(value(pinnedDefault, "availability"), "available");
});

test("local GPU models are judged by the probe result", () => {
  const selection = { harness: "pi", model: "ornith-local/ornith-1.5-35b-a3b", reasoning: "" };
  const up = modelFactsReport({ selection, catalog, harnesses: [unlisted], context: "personal", providers: { "ornith-local": { status: "up", models: ["ornith-1.5-35b-a3b"] } } });
  assert.equal(value(up, "availability"), "available");

  const upWithout = modelFactsReport({ selection, catalog, harnesses: [unlisted], context: "personal", providers: { "ornith-local": { status: "up", models: ["other-model"] } } });
  assert.equal(value(upWithout, "availability"), "unavailable");

  const down = modelFactsReport({ selection, catalog, harnesses: [unlisted], context: "personal", providers: { "ornith-local": { status: "down", models: [] } } });
  assert.equal(value(down, "availability"), "unavailable");

  // A probe that timed out is unknown, not down.
  const timedOut = modelFactsReport({ selection, catalog, harnesses: [unlisted], context: "personal", providers: { "ornith-local": { status: "unknown", models: [] } } });
  assert.equal(value(timedOut, "availability"), "unknown");
});

test("tooltip keeps the full set of facts, one per line", () => {
  const report = modelFactsReport({ selection: { harness: "claude", model: "opus", reasoning: "high" }, catalog, harnesses: [claude], context: "professional" });
  const lines = report.title.split("\n");
  assert.equal(lines[0], "claude · opus · high");
  assert.ok(lines.some((line) => line.startsWith("Quality: 52 index")));
  assert.ok(lines.some((line) => line.startsWith("Facts as of: 2026-11-11")));
});
