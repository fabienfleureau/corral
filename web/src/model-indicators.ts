// Model facts for a choice: quality, cost, quota left, speed, data retention,
// availability — plus the professional-repo warnings. Pure data: nothing here
// picks a model, and no warning ever blocks a dispatch.
//
// factsFor/effortFacts mirror server/model-catalog.ts (the web bundle cannot
// read the server's shipped JSON); server/test covers both copies.

import type { AgentQuota, Context, ModelAvailability, ModelCatalog, ModelFacts, Retention } from "./types.ts";

export interface ModelSelection {
  harness: string;
  model: string;
  reasoning: string;
}

/** Harness catalog entry from GET /api/harnesses (models only when reported). */
export interface HarnessModels {
  harness: string;
  models?: { id: string }[];
}

export interface IndicatorInput {
  selection: ModelSelection;
  catalog: ModelCatalog;
  /** Quota snapshots from GET /api/usage (Claude and Codex only). */
  quota?: AgentQuota[];
  /** Harness list from GET /api/harnesses. */
  harnesses: HarnessModels[];
  /** Repo context: warnings apply to professional work only. */
  context: Context | null;
  /** GET /api/models/availability: provider id -> local model server probe. */
  providers?: Record<string, ModelAvailability>;
}

export interface ModelIndicator {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

export interface ModelWarning {
  key: string;
  /** Short badge text; the message is the explanation. */
  label: string;
  message: string;
}

export interface ModelFactsReport {
  /** False when the catalog has no entry: the choice shows "no data". */
  hasFacts: boolean;
  /** Compact one-liner for a favorite chip ("52 index · $3.46/task"). */
  summary: string;
  retention: Retention | null;
  indicators: ModelIndicator[];
  warnings: ModelWarning[];
  /** Every indicator and warning, one per line: the tooltip. */
  title: string;
}

const RETENTION_LABELS: Record<Retention, string> = {
  none: "none",
  "30d": "30 days",
  trains: "trains on prompts",
  unknown: "unknown",
};

export function retentionLabel(retention: Retention): string {
  return RETENTION_LABELS[retention];
}

/** Mirror of server/model-catalog.ts RETENTIONS (the Settings editor offers them). */
export const RETENTIONS: readonly Retention[] = ["none", "30d", "trains", "unknown"];

/** Harnesses cleared for professional work (a user decision, not a measurement). */
export const PROFESSIONAL_HARNESSES: readonly string[] = ["claude", "codex"];

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
export function effortFacts(facts: ModelFacts, reasoning: string): { index?: number; costPerTask?: number; minPerTask?: number } | null {
  const efforts = facts.efforts;
  if (!efforts) return null;
  if (reasoning && efforts[reasoning]) return efforts[reasoning];
  return efforts.default ?? null;
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;
const minutes = (value: number): string => `${Number.isInteger(value) ? value : value.toFixed(1)} min`;
/** "claude-fable-5-1[1m]" and "claude-fable-5-1" are the same model. */
const bareId = (id: string): string => id.replace(/\[[^\]]*\]$/, "");

/** The local model server a model id belongs to ("ornith-local/x" -> "ornith-local"). */
function localProviderOf(model: string, providers: Record<string, ModelAvailability> | undefined): { provider: string; id: string; probe: ModelAvailability } | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || !providers) return null;
  const provider = model.slice(0, slash);
  const probe = providers[provider];
  return probe ? { provider, id: model.slice(slash + 1), probe } : null;
}

function availabilityIndicator(input: IndicatorInput): ModelIndicator {
  const { selection } = input;
  const local = localProviderOf(selection.model, input.providers);
  if (local) {
    if (local.probe.status === "up") {
      return local.probe.models.includes(local.id)
        ? { key: "availability", label: "Availability", value: "available", hint: `${local.provider} lists this model` }
        : { key: "availability", label: "Availability", value: "unavailable", hint: `${local.provider} is up but does not list ${local.id}` };
    }
    // A server that did not answer in time is unknown — never "down".
    return local.probe.status === "down"
      ? { key: "availability", label: "Availability", value: "unavailable", hint: `${local.provider} did not answer` }
      : { key: "availability", label: "Availability", value: "unknown", hint: `${local.provider} did not answer in time` };
  }
  const harness = input.harnesses.find((h) => h.harness === selection.harness);
  if (!harness) return { key: "availability", label: "Availability", value: "unavailable", hint: `${selection.harness} is not in the harness list` };
  if (!selection.model) return { key: "availability", label: "Availability", value: "available", hint: "no model pinned: the harness picks" };
  const models = harness.models ?? [];
  if (models.length === 0) return { key: "availability", label: "Availability", value: "unknown", hint: `${selection.harness} does not report a model catalog` };
  const listed = models.some((model) => bareId(model.id) === bareId(selection.model));
  return listed
    ? { key: "availability", label: "Availability", value: "available", hint: `${selection.harness} lists this model` }
    : { key: "availability", label: "Availability", value: "unavailable", hint: `${selection.harness} does not list this model` };
}

function quotaIndicator(selection: ModelSelection, quota: AgentQuota[] | undefined): ModelIndicator | null {
  if (!PROFESSIONAL_HARNESSES.includes(selection.harness)) return null;
  const snapshot = (quota ?? []).find((q) => q.agent === selection.harness);
  if (!snapshot || snapshot.windows.length === 0) {
    return { key: "quota", label: "Quota left", value: "unknown", hint: snapshot?.note ?? "no quota snapshot yet" };
  }
  const left = snapshot.windows.map((w) => `${w.label} ${Math.round(100 - w.used_percent)}% left`);
  return {
    key: "quota",
    label: "Quota left",
    value: left.join(" · "),
    hint: snapshot.stale ? `${snapshot.source} (stale: the snapshot predates a window reset)` : snapshot.source,
  };
}

function benchHint(facts: ModelFacts): string | undefined {
  const rows = Object.entries(facts.bench ?? {});
  return rows.length ? rows.map(([name, score]) => `${name} ${score}`).join(" · ") : undefined;
}

/** Indicators + warnings for one model choice. Never throws, never blocks. */
export function modelFactsReport(input: IndicatorInput): ModelFactsReport {
  const { selection } = input;
  const facts = factsFor(selection.model, input.catalog);
  const effort = facts ? effortFacts(facts, selection.reasoning) : null;
  const indicators: ModelIndicator[] = [];
  const summaryParts: string[] = [];

  if (!facts) {
    indicators.push({
      key: "facts",
      label: "Model facts",
      value: "no data",
      hint: `No catalog entry for ${selection.model || "the harness default"}. Add one in Settings › Models.`,
    });
  } else {
    if (effort?.index !== undefined) {
      const hint = benchHint(facts);
      indicators.push({ key: "quality", label: "Quality", value: `${effort.index} index`, ...(hint ? { hint } : {}) });
      summaryParts.push(`${effort.index} index`);
    } else {
      const hint = benchHint(facts);
      indicators.push({ key: "quality", label: "Quality", value: "no index", ...(hint ? { hint } : {}) });
      summaryParts.push("no index");
    }
    if (effort?.costPerTask !== undefined) {
      indicators.push({
        key: "cost",
        label: "Cost",
        value: `${money(effort.costPerTask)}/task`,
        hint: facts.quota ? `counts against a ${money(facts.quota.monthlyUsd)} monthly plan limit` : "measured cost per task",
      });
      summaryParts.push(`${money(effort.costPerTask)}/task`);
    }
    if (effort?.minPerTask !== undefined) {
      indicators.push({ key: "speed", label: "Speed", value: `${minutes(effort.minPerTask)}/task` });
    }
    indicators.push({ key: "retention", label: "Data retention", value: retentionLabel(facts.retention) });
  }

  indicators.push(availabilityIndicator(input));
  const quotaRow = quotaIndicator(selection, input.quota);
  if (quotaRow) indicators.push(quotaRow);
  if (facts) indicators.push({ key: "asOf", label: "Facts as of", value: facts.asOf, ...(facts.source ? { hint: facts.source } : {}) });

  const warnings: ModelWarning[] = [];
  if (input.context === "professional") {
    if (facts && facts.retention !== "none") {
      warnings.push({
        key: "retention",
        label: `retention ${retentionLabel(facts.retention)}`,
        message: `Data retention is ${retentionLabel(facts.retention)}: not cleared for professional work. The dispatch still goes through.`,
      });
    }
    if (!PROFESSIONAL_HARNESSES.includes(selection.harness)) {
      warnings.push({
        key: "harness",
        label: `${selection.harness} harness`,
        message: `${selection.harness} is not a Claude or ChatGPT harness: professional work is only cleared on claude and codex. The dispatch still goes through.`,
      });
    }
  }

  const heading = [
    selection.harness || "no harness",
    selection.model || "harness default",
    selection.reasoning || "default reasoning",
  ].join(" · ");
  const title = [
    heading,
    ...indicators.map((row) => `${row.label}: ${row.value}${row.hint ? ` (${row.hint})` : ""}`),
    ...warnings.map((warning) => `⚠ ${warning.message}`),
  ].join("\n");

  return {
    hasFacts: facts !== null,
    summary: facts ? summaryParts.join(" · ") || "no numbers" : "no data",
    retention: facts?.retention ?? null,
    indicators,
    warnings,
    title,
  };
}
