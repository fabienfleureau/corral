// Model facts: what a human needs to choose well — quality, cost, quota, speed,
// data retention. Data, never policy: Corral chooses nothing here and a warning
// never blocks a dispatch.
//
// Shipped defaults live in model-catalog.json; config.models overrides them per
// model key, so a new model release is a JSON edit, not a code change. Keys are
// the model ids the harnesses really report (GET /api/harnesses, `opencode
// models`); "prefix*" covers ids a harness suffixes with a date or variant.

import { readFileSync } from "node:fs";

export type Retention = "none" | "30d" | "trains" | "unknown";

export const RETENTIONS: readonly Retention[] = ["none", "30d", "trains", "unknown"];

export interface EffortFacts {
  index?: number;
  costPerTask?: number;
  minPerTask?: number;
}

export interface ModelFacts {
  retention: Retention;
  quota?: { monthlyUsd: number };
  /** Key = the reasoning value the harness reports; "default" is the fallback. */
  efforts?: Record<string, EffortFacts>;
  bench?: Record<string, number>;
  /** YYYY-MM-DD the numbers were collected. */
  asOf: string;
  source?: string;
}

export type ModelCatalog = Record<string, ModelFacts>;

/** The shipped defaults (data the user can override in Settings). */
export const SHIPPED_CATALOG: ModelCatalog = JSON.parse(
  readFileSync(new URL("./model-catalog.json", import.meta.url), "utf8"),
) as ModelCatalog;

/** Exact model id first, then the longest "prefix*" — same rule as priceFor. */
export function factsFor(model: string, catalog: ModelCatalog): ModelFacts | null {
  if (!model) return null;
  const exact = catalog[model];
  if (exact) return exact;
  let best: { len: number; facts: ModelFacts } | null = null;
  for (const [pattern, facts] of Object.entries(catalog)) {
    if (!pattern.endsWith("*")) continue;
    const prefix = pattern.slice(0, -1);
    if (model.startsWith(prefix) && (!best || prefix.length > best.len)) best = { len: prefix.length, facts };
  }
  return best?.facts ?? null;
}

/** The entry for this reasoning value, else "default", else null. */
export function effortFacts(facts: ModelFacts, reasoning: string): EffortFacts | null {
  const efforts = facts.efforts;
  if (!efforts) return null;
  if (reasoning && efforts[reasoning]) return efforts[reasoning];
  return efforts.default ?? null;
}

/** User entries win per model key; shipped entries survive untouched. */
export function mergeCatalog(shipped: ModelCatalog, user: ModelCatalog | undefined): ModelCatalog {
  return { ...shipped, ...(user ?? {}) };
}

// ---- validation (PUT /api/config) ----

function fail(message: string): never {
  throw new Error(message);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numbers = (value: unknown, where: string, keys: readonly string[]): void => {
  if (value === undefined) return;
  if (!isObject(value)) fail(`${where} must be an object`);
  for (const key of keys) {
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined) continue;
    if (typeof field !== "number" || !Number.isFinite(field)) fail(`${where}.${key} must be a number`);
  }
};

/** Validate one catalog entry; throws a message fit for a 400 response. */
export function parseModelFacts(value: unknown, key = "model"): ModelFacts {
  if (!isObject(value)) fail(`${key} must be an object`);
  const retention = value.retention;
  if (typeof retention !== "string" || !RETENTIONS.includes(retention as Retention)) {
    fail(`${key}.retention must be one of ${RETENTIONS.join(", ")}`);
  }
  if (typeof value.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf)) fail(`${key}.asOf must be YYYY-MM-DD`);
  if (value.source !== undefined && typeof value.source !== "string") fail(`${key}.source must be a string`);

  let quota: ModelFacts["quota"];
  if (value.quota !== undefined) {
    numbers(value.quota, `${key}.quota`, ["monthlyUsd"]);
    quota = value.quota as { monthlyUsd: number };
  }

  let efforts: ModelFacts["efforts"];
  if (value.efforts !== undefined) {
    if (!isObject(value.efforts)) fail(`${key}.efforts must be an object`);
    efforts = {};
    for (const [effort, facts] of Object.entries(value.efforts)) {
      numbers(facts, `${key}.efforts.${effort}`, ["index", "costPerTask", "minPerTask"]);
      efforts[effort] = facts as EffortFacts;
    }
  }

  let bench: ModelFacts["bench"];
  if (value.bench !== undefined) {
    if (!isObject(value.bench)) fail(`${key}.bench must be an object`);
    bench = {};
    for (const [name, score] of Object.entries(value.bench)) {
      if (typeof score !== "number" || !Number.isFinite(score)) fail(`${key}.bench.${name} must be a number`);
      bench[name] = score;
    }
  }

  return {
    retention: retention as Retention,
    ...(quota ? { quota } : {}),
    ...(efforts ? { efforts } : {}),
    ...(bench ? { bench } : {}),
    asOf: value.asOf,
    ...(typeof value.source === "string" ? { source: value.source } : {}),
  };
}

/** Validate a whole models map; throws a message fit for a 400 response. */
export function parseCatalog(value: unknown): ModelCatalog {
  if (!isObject(value)) fail("models must be an object");
  const out: ModelCatalog = {};
  for (const [key, facts] of Object.entries(value)) {
    if (!key.trim()) fail("model ids must not be empty");
    out[key] = parseModelFacts(facts, `models[${JSON.stringify(key)}]`);
  }
  return out;
}
