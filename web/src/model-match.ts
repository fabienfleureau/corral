// Model identity for the benchmark matrix. Published leaderboard labels
// ("Claude 4.5 Opus", "gpt-6.1-sol", "GLM-5.3-Flash") and harness catalog ids
// ("opencode/claude-sonnet-5-5", "claude-fable-5-1[1m]", "opus") have to land
// on the same row: the page compares the models a harness can actually run, so
// a benchmark result only counts when it is about one of those models.

export interface ModelIdentity {
  /** Vendor family after alias folding: "claude", "gpt", "gemini", … */
  family: string;
  /** Qualifier tokens after the family: "opus", "sol", "flash". */
  variant: string;
  /** Dotted version ("5.5") or null when the name carries none. */
  version: string | null;
}

export interface BenchmarkResultInput {
  id: string;
  benchmark: string;
  agent: string;
  model: string;
  reasoning: string | null;
  score: number;
  date: string | null;
  source: string;
}

export interface HarnessModelInput {
  harness: string;
  id: string;
  label: string;
}

export interface BenchmarkPick<T extends BenchmarkResultInput> {
  result: T;
  /** Other published results for the same model and benchmark. */
  alternatives: number;
}

export interface BenchmarkRow<T extends BenchmarkResultInput> {
  key: string;
  identity: ModelIdentity;
  /** Published model name when the row has results, otherwise the harness label. */
  label: string;
  /** The published name this row resolved to (null when unpublished). */
  published: string | null;
  availability: HarnessModelInput[];
  /** Best published result per benchmark name. */
  picks: Record<string, BenchmarkPick<T>>;
}

/** Harness aliases that mean a Claude model: "opus", "sonnet", "haiku", "fable". */
const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
/** Vendor prefixes that add nothing to an identity. */
const VENDOR_TOKENS = new Set(["anthropic", "openai", "google", "alibaba", "moonshot", "zhipu", "meta", "meta-llama", "xai"]);
/** Access/publication qualifiers that do not change the model. */
const NOISE_TOKENS = new Set(["free", "contributor", "preview", "latest"]);
/** Parameter-count suffixes ("7b", "72b", "480b"): the same model at any size. */
const SIZE_TOKEN = /^\d+(?:\.\d+)?[bm]$/;
/** A version part: at most two digits either side ("5", "4.5", "6.1"). */
const VERSION_TOKEN = /^\d{1,2}(?:\.\d{1,2})?$/;

/** Split a model name into lowercase word and version tokens. */
function nameTokens(raw: string): string[] {
  const bare = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split("/").pop() ?? "";
  return bare
    .replace(/\[[^\]]*\]/g, " ") // "[1m]" context windows
    .replace(/\([^)]*\)/g, " ") // "(2512)" publication dates, "(7B + 72B)" sizes
    .split(/[^a-z0-9.]+/)
    .filter(Boolean)
    .flatMap((token) => token.replace(/([a-z])(\d)/g, "$1 $2").split(" ")) // "qwen3.8" -> "qwen 3.8"
    .filter(Boolean);
}

/** Drop leading zeros and a trailing ".0": "05.50" -> "5.5", "6.0" -> "6". */
function normalizeVersion(parts: string[]): string | null {
  if (!parts.length) return null;
  const numbers = parts.map((part) => String(Number(part)));
  while (numbers.length > 1 && numbers[numbers.length - 1] === "0") numbers.pop();
  return numbers.join(".");
}

/**
 * Canonical identity of a model name: family, qualifier tokens and version.
 * Order does not matter ("Claude 4.5 Opus" = "Opus 4.5"), aliases fold into
 * their family ("Fable 5.1" = "claude-fable-5-1"), and deployment qualifiers
 * ("free", "contributor", "preview") are ignored.
 */
export function parseModelName(raw: string): ModelIdentity {
  let family = "";
  const variant: string[] = [];
  const versions: string[] = [];
  for (const token of nameTokens(raw)) {
    if (SIZE_TOKEN.test(token) || NOISE_TOKENS.has(token)) continue;
    if (VERSION_TOKEN.test(token)) {
      versions.push(token);
      continue;
    }
    // Publication dates and run ids ("20241022", "0324") are not model qualifiers.
    if (/^\d+$/.test(token) && token.length > 2) continue;
    if (!family) {
      if (!VENDOR_TOKENS.has(token)) family = CLAUDE_ALIASES.has(token) ? "claude" : token;
      if (CLAUDE_ALIASES.has(token)) variant.push(token);
      continue;
    }
    variant.push(token);
  }
  return { family, variant: variant.join(" "), version: normalizeVersion(versions) };
}

/** Group key: models of the same family and variant, any version. */
function familyKey(identity: ModelIdentity): string {
  return `${identity.family}\u0000${identity.variant}`;
}

function rowKey(identity: ModelIdentity): string {
  return `${familyKey(identity)}\u0000${identity.version ?? "*"}`;
}

/** Compare dotted versions; missing parts count as zero. */
export function compareVersions(a: string | null, b: string | null): number {
  const left = (a ?? "").split(".").filter(Boolean).map(Number);
  const right = (b ?? "").split(".").filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** True when both names describe the same model (a missing version matches any). */
export function sameModel(a: ModelIdentity, b: ModelIdentity): boolean {
  return familyKey(a) === familyKey(b) && (a.version === null || b.version === null || a.version === b.version);
}

function isBetter<T extends BenchmarkResultInput>(candidate: T, current: T): boolean {
  if (candidate.score !== current.score) return candidate.score > current.score;
  const candidateDate = candidate.date ?? "";
  const currentDate = current.date ?? "";
  if (candidateDate !== currentDate) return candidateDate > currentDate;
  return candidate.id < current.id;
}

/**
 * Build the matrix rows: one row per model identity, with harness availability
 * and the best published result per benchmark.
 *
 * Unversioned harness aliases ("opus") resolve to the newest published version
 * of that family+variant, which is what those aliases point at in a catalog.
 */
export function buildBenchmarkRows<T extends BenchmarkResultInput>(
  harnessModels: HarnessModelInput[],
  results: T[],
): BenchmarkRow<T>[] {
  const newest = new Map<string, string>();
  for (const result of results) {
    const identity = parseModelName(result.model);
    if (!identity.family || !identity.version) continue;
    const key = familyKey(identity);
    const known = newest.get(key);
    if (!known || compareVersions(identity.version, known) > 0) newest.set(key, identity.version);
  }

  const rows = new Map<string, BenchmarkRow<T>>();
  const row = (identity: ModelIdentity): BenchmarkRow<T> => {
    const key = rowKey(identity);
    let existing = rows.get(key);
    if (!existing) {
      existing = { key, identity, label: "", published: null, availability: [], picks: {} };
      rows.set(key, existing);
    }
    return existing;
  };

  for (const model of harnessModels) {
    const identity = parseModelName(model.label || model.id);
    if (!identity.family) continue;
    const resolved: ModelIdentity = identity.version ? identity : { ...identity, version: newest.get(familyKey(identity)) ?? null };
    row(resolved).availability.push(model);
  }

  const counts = new Map<string, number>();
  for (const result of results) {
    const identity = parseModelName(result.model);
    if (!identity.family) continue;
    const target = row(identity);
    const countKey = `${target.key}\u0000${result.benchmark}`;
    counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
    const pick = target.picks[result.benchmark];
    if (!pick || isBetter(result, pick.result)) target.picks[result.benchmark] = { result, alternatives: 0 };
  }

  for (const entry of rows.values()) {
    for (const [benchmark, pick] of Object.entries(entry.picks)) {
      pick.alternatives = (counts.get(`${entry.key}\u0000${benchmark}`) ?? 1) - 1;
    }
  }

  for (const entry of rows.values()) {
    entry.availability.sort((a, b) => a.harness.localeCompare(b.harness) || a.id.localeCompare(b.id));
    // The published name is the clearest label; fall back to the harness label.
    const picks = Object.values(entry.picks);
    const best = picks.reduce<BenchmarkPick<T> | null>((top, pick) => (!top || isBetter(pick.result, top.result) ? pick : top), null);
    entry.published = best?.result.model ?? null;
    entry.label = entry.published ?? entry.availability[0]?.label ?? entry.availability[0]?.id ?? "";
  }

  return [...rows.values()].sort((a, b) => {
    // Models with published results first, then the rest of the harness
    // catalog, then published models outside it.
    const rank = (row: BenchmarkRow<T>) => (row.availability.length ? (Object.keys(row.picks).length ? 0 : 1) : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const family = a.identity.family.localeCompare(b.identity.family);
    if (family) return family;
    const variant = a.identity.variant.localeCompare(b.identity.variant);
    if (variant) return variant;
    const version = compareVersions(b.identity.version, a.identity.version);
    if (version) return version;
    return a.label.localeCompare(b.label);
  });
}

/** Benchmark columns, most-covered first, then alphabetical. */
export function benchmarkColumns(rows: { picks: Record<string, unknown> }[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const name of Object.keys(row.picks)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}
