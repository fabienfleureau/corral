import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHIPPED_CATALOG,
  effortFacts,
  factsFor,
  mergeCatalog,
  parseCatalog,
} from "../model-catalog.ts";
import type { ModelCatalog } from "../model-catalog.ts";

const catalog: ModelCatalog = {
  "opus": {
    retention: "none",
    efforts: { high: { index: 52, costPerTask: 3.46, minPerTask: 9.5 }, default: { index: 35 } },
    bench: { "Terminal-Bench 4.0": 66.4 },
    asOf: "2026-11-11",
  },
  "opencode-go/kimi-k3.1-pro": { retention: "none", quota: { monthlyUsd: 15 }, efforts: { default: { index: 46 } }, asOf: "2026-11-11" },
  "claude-opus-5*": { retention: "none", efforts: { default: { index: 59 } }, asOf: "2026-11-11" },
  "claude-opus-5-5*": { retention: "none", efforts: { default: { index: 60 } }, asOf: "2026-11-11" },
};

test("factsFor prefers the exact model id", () => {
  assert.equal(factsFor("opus", catalog)?.efforts?.high?.index, 52);
  assert.equal(factsFor("opencode-go/kimi-k3.1-pro", catalog)?.quota?.monthlyUsd, 15);
});

test("factsFor falls back to the longest prefix* and ignores unknown models", () => {
  assert.equal(factsFor("claude-opus-5-5[1m]", catalog)?.efforts?.default?.index, 60);
  assert.equal(factsFor("claude-opus-5-6-preview", catalog)?.efforts?.default?.index, 59);
  assert.equal(factsFor("gpt-6.1-sol", catalog), null);
  assert.equal(factsFor("", catalog), null);
});

test("effortFacts uses the reasoning value, then default, then nothing", () => {
  const facts = catalog.opus;
  assert.equal(effortFacts(facts, "high")?.index, 52);
  assert.equal(effortFacts(facts, "max")?.index, 35); // no "max" entry -> default
  assert.equal(effortFacts(facts, "")?.index, 35);
  assert.equal(effortFacts({ retention: "none", asOf: "2026-11-11" }, "high"), null);
});

test("a user entry wins per model key and leaves shipped keys alone", () => {
  const merged = mergeCatalog(catalog, { "opus": { retention: "30d", efforts: { default: { index: 1 } }, asOf: "2026-12-01" }, "acme/private": { retention: "unknown", asOf: "2026-12-01" } });
  assert.equal(merged.opus.retention, "30d");
  assert.equal(merged.opus.efforts?.default?.index, 1);
  assert.equal(factsFor("opencode-go/kimi-k3.1-pro", merged)?.quota?.monthlyUsd, 15);
  assert.equal(factsFor("acme/private", merged)?.retention, "unknown");
  assert.equal(catalog.opus.retention, "none", "the shipped entry is not mutated");
});

test("the shipped catalog is valid and keyed by model ids harnesses report", () => {
  assert.deepEqual(parseCatalog(SHIPPED_CATALOG), SHIPPED_CATALOG);
  for (const id of ["opus", "sonnet", "haiku", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "opencode-go/deepseek-v4.1-flash", "opencode-go/beam-free", "opencode-go/claude-haiku-5-5"]) {
    assert.ok(SHIPPED_CATALOG[id], `missing shipped facts for ${id}`);
  }
  assert.equal(SHIPPED_CATALOG["opencode-go/beam-free"].retention, "30d");
  assert.equal(SHIPPED_CATALOG.opus.retention, "none");
});

test("validation rejects a bad retention, a non-numeric value and a bad date", () => {
  const facts = { retention: "none", asOf: "2026-11-11" };
  assert.deepEqual(parseCatalog({ "x/model": facts }), { "x/model": { retention: "none", asOf: "2026-11-11" } });
  assert.throws(() => parseCatalog({ "x/model": { ...facts, retention: "forever" } }), /retention must be one of/);
  assert.throws(() => parseCatalog({ "x/model": { ...facts, efforts: { high: { index: "52" } } } }), /must be a number/);
  assert.throws(() => parseCatalog({ "x/model": { ...facts, quota: { monthlyUsd: "15" } } }), /must be a number/);
  assert.throws(() => parseCatalog({ "x/model": { ...facts, bench: { "SWE-bench": "70" } } }), /must be a number/);
  assert.throws(() => parseCatalog({ "x/model": { ...facts, asOf: "11/11/2026" } }), /asOf must be YYYY-MM-DD/);
  assert.throws(() => parseCatalog({ "": facts }), /must not be empty/);
  assert.throws(() => parseCatalog([] as unknown), /models must be an object/);
});

test("validation keeps every effort key, including prefix-style ids", () => {
  const parsed = parseCatalog({
    "claude-opus-5*": { retention: "none", asOf: "2026-11-11", efforts: { low: { index: 35, costPerTask: 0.98, minPerTask: 2.9 }, default: { index: 48 } }, bench: { "Terminal-Bench 4.0": 66.4 }, source: "collected" },
  });
  assert.deepEqual(parsed["claude-opus-5*"].efforts, { low: { index: 35, costPerTask: 0.98, minPerTask: 2.9 }, default: { index: 48 } });
  assert.equal(parsed["claude-opus-5*"].source, "collected");
});
