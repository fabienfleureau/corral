// Agent usage: tokens, estimated cost and quota for Claude Code, Codex,
// OpenCode Go and Antigravity, read from their local session logs. Costs are API-equivalent estimates
// (subscriptions are not billed per token).
//
// Sources:
// - Claude Code: ~/.claude/projects/**/*.jsonl, one line per content block,
//   each repeating message.usage -> dedupe by message.id + requestId.
// - Codex: ~/.codex/sessions/**/rollout-*.jsonl, token_count events carry a
//   running total -> count deltas; model from the latest turn_context.
// - Antigravity: <home>/brain/<conversation>/.system_generated/logs/
//   transcript_full.jsonl, one line per step; model steps carry input (uncached),
//   cache_read and output tokens. Homes: ~/.gemini/antigravity-cli,
//   ~/.gemini/antigravity-acp and each omnigent session's agy-home under
//   ~/.omnigent/antigravity-native. cwd = the conversation's workspace in
//   <home>/conversation_summaries.db.
// - Claude quota: ccstatusline's cache (~/.cache/ccstatusline/usage*.json).
// - Codex quota: rate_limits on the latest token_count event.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { taskLabel, type Task } from "./types.ts";
import { withDeadline } from "./deadline.ts";

export type UsageAgent = "claude" | "codex" | "opencode-go" | "antigravity";

/** One API call (Claude) or one token_count delta (Codex). */
export interface UsageRecord {
  agent: UsageAgent;
  /** Dedupe key; empty = never dedupe. */
  key: string;
  ts: number;
  model: string;
  cwd: string;
  /** Uncached input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** USD per million tokens. Cache fields default from input (read 0.1x, write 1.25x / 2x). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

// API list prices in USD per million tokens. Config prices can override these.
// Anthropic: as of 2026-10-06; OpenAI, Xiaomi and OpenCode: as of 2026-11-05.
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5*": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4*": { input: 5, output: 25 },
  "claude-sonnet-5*": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4*": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4*": { input: 1, output: 5 },
  // Standard short-context rates: https://developers.openai.com/api/docs/pricing
  "gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1 },
  // https://mimo.mi.com/docs/price
  "mimo-v2.6-pro": { input: 0.435, output: 0.87, cacheRead: 0.0036 },
  // https://dev.opencode.ai/v2/docs/console/models
  "beam-free": { input: 0, output: 0 },
  // Standard paid tier, output includes thinking. Antigravity suffixes the
  // effort and tier ("gemini-4-neon-medium"), priced at the base model's rate.
  // https://aistudio.google.com/docs/pricing (as of 2026-11-24)
  "gemini-4-neon*": { input: 3, output: 15, cacheRead: 0.15 },
  "gemini-4-hydrogen*": { input: 1.5, output: 7.5, cacheRead: 0.075 },
};

export function priceFor(model: string, prices: Record<string, ModelPrice>): ModelPrice | null {
  if (prices[model]) return prices[model];
  let best: { len: number; price: ModelPrice } | null = null;
  for (const [pattern, price] of Object.entries(prices)) {
    if (!pattern.endsWith("*")) continue;
    const prefix = pattern.slice(0, -1);
    if (model.startsWith(prefix) && (!best || prefix.length > best.len)) best = { len: prefix.length, price };
  }
  return best?.price ?? null;
}

export function recordCost(r: UsageRecord, prices: Record<string, ModelPrice>): number | null {
  const p = priceFor(r.model, prices);
  if (!p) return null;
  const usd =
    r.input * p.input +
    r.output * p.output +
    r.cacheRead * (p.cacheRead ?? p.input * 0.1) +
    r.cacheWrite5m * (p.cacheWrite5m ?? p.input * 1.25) +
    r.cacheWrite1h * (p.cacheWrite1h ?? p.input * 2);
  return usd / 1_000_000;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ---- parsers (pure, line-based) ----

/** Parse one Claude Code jsonl line; null when it carries no billable usage. */
export function parseClaudeLine(line: string): UsageRecord | null {
  if (!line.includes('"usage"')) return null;
  let d: Record<string, any>;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = d.message;
  const u = msg?.usage;
  if (d.type !== "assistant" || !u || typeof msg.model !== "string" || msg.model === "<synthetic>") return null;
  const write = num(u.cache_creation_input_tokens);
  const w1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
  const w5m = u.cache_creation ? num(u.cache_creation.ephemeral_5m_input_tokens) : write;
  return {
    agent: "claude",
    key: `${msg.id ?? ""}:${d.requestId ?? ""}`,
    ts: Date.parse(d.timestamp) || 0,
    model: msg.model,
    cwd: typeof d.cwd === "string" ? d.cwd : "",
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
  };
}

export interface CodexRateWindow {
  used_percent: number;
  window_minutes: number;
  resets_at: number | null;
}
export interface CodexRateLimits {
  ts: number;
  plan: string | null;
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
}

export interface CodexParse {
  records: UsageRecord[];
  rateLimits: CodexRateLimits | null;
}

/** Parse a whole Codex rollout file (as lines). */
export function parseCodexLines(lines: Iterable<string>, fileKey: string): CodexParse {
  const records: UsageRecord[] = [];
  let rateLimits: CodexRateLimits | null = null;
  let cwd = "";
  let model = "unknown";
  let prev = { input: 0, cached: 0, output: 0 };
  let n = 0;
  for (const line of lines) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = d.payload ?? {};
    if (d.type === "session_meta") {
      if (typeof p.cwd === "string") cwd = p.cwd;
    } else if (d.type === "turn_context") {
      if (typeof p.model === "string") model = p.model;
      if (typeof p.cwd === "string" && !cwd) cwd = p.cwd;
    } else if (d.type === "event_msg" && p.type === "token_count") {
      const ts = Date.parse(d.timestamp) || 0;
      const rl = p.rate_limits;
      if (rl && (!rateLimits || ts >= rateLimits.ts)) {
        const win = (w: any): CodexRateWindow | null =>
          w ? { used_percent: num(w.used_percent), window_minutes: num(w.window_minutes), resets_at: w.resets_at ? num(w.resets_at) * 1000 : null } : null;
        rateLimits = { ts, plan: typeof rl.plan_type === "string" ? rl.plan_type : null, primary: win(rl.primary), secondary: win(rl.secondary) };
      }
      const t = p.info?.total_token_usage;
      if (!t) continue;
      const cur = { input: num(t.input_tokens), cached: num(t.cached_input_tokens), output: num(t.output_tokens) };
      // Totals only grow within a session; a drop means a reset (new context) -> start over.
      const base = cur.input < prev.input || cur.output < prev.output ? { input: 0, cached: 0, output: 0 } : prev;
      const dIn = cur.input - base.input;
      const dCached = Math.max(0, cur.cached - base.cached);
      const dOut = cur.output - base.output;
      prev = cur;
      if (dIn === 0 && dOut === 0) continue;
      records.push({
        agent: "codex",
        key: `${fileKey}#${n++}`,
        ts,
        model,
        cwd,
        // cached_input_tokens is a subset of input_tokens.
        input: Math.max(0, dIn - dCached),
        output: dOut,
        cacheRead: dCached,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      });
    }
  }
  return { records, rateLimits };
}

/** Parse an Antigravity transcript_full.jsonl. input_tokens excludes cache
 *  reads (cache_read_tokens is often larger), so both map as they are. */
export function parseAntigravityLines(lines: Iterable<string>, conversationId: string, cwd: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of lines) {
    if (!line.includes('"output_tokens"')) continue;
    let d: Record<string, any>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof d.output_tokens !== "number" && typeof d.input_tokens !== "number") continue;
    records.push({
      agent: "antigravity",
      key: `antigravity:${conversationId}:${d.step_index ?? records.length}`,
      ts: Date.parse(d.created_at) || 0,
      model: typeof d.model === "string" && d.model ? d.model : "unknown",
      cwd,
      input: num(d.input_tokens),
      output: num(d.output_tokens),
      cacheRead: num(d.cache_read_tokens),
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
  }
  return records;
}

/** Conversation id -> workspace path, from an Antigravity home's summaries DB.
 *  Sub-agent conversations have no workspace: when the home holds a single
 *  workspace (one omnigent session), they get that one. */
function antigravityWorkspaces(home: string): { get(conversationId: string): string } {
  const map = new Map<string, string>();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(home, "conversation_summaries.db"), { readOnly: true });
    for (const row of db.prepare("SELECT conversation_id, workspace_uris FROM conversation_summaries").all()) {
      try {
        const uris = JSON.parse(String(row.workspace_uris));
        const first = Array.isArray(uris) ? uris.find((u) => typeof u === "string" && u.startsWith("file://")) : undefined;
        if (first) map.set(String(row.conversation_id), fileURLToPath(first));
      } catch { /* Ignore malformed rows. */ }
    }
  } catch { /* No summaries yet: cwd stays empty. */ } finally { db?.close(); }
  const distinct = new Set(map.values());
  const only = distinct.size === 1 ? [...distinct][0] : "";
  return { get: (id) => map.get(id) ?? only };
}

/** Where an Antigravity transcript lives: its home and conversation id. */
function antigravityTranscript(path: string): { home: string; conversation: string } | null {
  const marker = `${sep}brain${sep}`;
  const i = path.lastIndexOf(marker);
  if (i < 0) return null;
  const conversation = path.slice(i + marker.length).split(sep)[0];
  return conversation ? { home: path.slice(0, i), conversation } : null;
}

// ---- file scanning with a per-file cache ----

function listJsonl(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

async function* readLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

interface FileEntry {
  size: number;
  mtimeMs: number;
  records: UsageRecord[];
  rateLimits: CodexRateLimits | null;
}

export interface UsageSources {
  claudeDir: string;
  codexDir: string;
  claudeQuotaDir: string;
  opencodeDir?: string;
  /** Roots searched for Antigravity transcript_full.jsonl files. */
  antigravityDirs?: string[];
}

export function defaultSources(): UsageSources {
  const home = homedir();
  return {
    claudeDir: join(home, ".claude", "projects"),
    codexDir: join(home, ".codex", "sessions"),
    claudeQuotaDir: join(home, ".cache", "ccstatusline"),
    opencodeDir: process.env.OPENCODE_DATA_DIR || join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode"),
    antigravityDirs: [
      join(home, ".gemini", "antigravity-cli"),
      join(home, ".gemini", "antigravity-acp"),
      join(home, ".omnigent", "antigravity-native"),
    ],
  };
}

export class UsageScanner {
  private files = new Map<string, FileEntry>();
  private running: Promise<void> | null = null;
  private lastScan = 0;
  private opencodeRecords: UsageRecord[] = [];
  ready = false;
  readonly sources: UsageSources;

  constructor(sources: UsageSources) {
    this.sources = sources;
  }

  /** Rescan changed files; concurrent callers share one pass. Throttled to once per 30s. */
  refresh(force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && this.ready && Date.now() - this.lastScan < 30_000) return Promise.resolve();
    this.running = this.scan().finally(() => {
      this.running = null;
      this.lastScan = Date.now();
      this.ready = true;
    });
    return this.running;
  }

  /** True while the first or a forced scan is still running. */
  get scanning(): boolean {
    return !this.ready || this.running !== null;
  }

  private async scan(): Promise<void> {
    this.opencodeRecords = readOpenCode(this.sources.opencodeDir);
    const seen = new Set<string>();
    const jobs: [string, UsageAgent][] = [
      ...listJsonl(this.sources.claudeDir).map((p): [string, UsageAgent] => [p, "claude"]),
      ...listJsonl(this.sources.codexDir).map((p): [string, UsageAgent] => [p, "codex"]),
      // transcript.jsonl and chunks/ repeat the same steps: read the full one only.
      ...(this.sources.antigravityDirs ?? [])
        .flatMap((dir) => listJsonl(dir))
        .filter((p) => p.endsWith(`${sep}transcript_full.jsonl`))
        .map((p): [string, UsageAgent] => [p, "antigravity"]),
    ];
    const workspaces = new Map<string, ReturnType<typeof antigravityWorkspaces>>();
    for (const [path, agent] of jobs) {
      seen.add(path);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const cached = this.files.get(path);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) continue;
      try {
        if (agent === "claude") {
          const records: UsageRecord[] = [];
          for await (const line of readLines(path)) {
            const r = parseClaudeLine(line);
            if (r) records.push(r);
          }
          this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, records, rateLimits: null });
        } else if (agent === "antigravity") {
          const where = antigravityTranscript(path);
          if (!where) continue;
          let ws = workspaces.get(where.home);
          if (!ws) workspaces.set(where.home, (ws = antigravityWorkspaces(where.home)));
          const lines: string[] = [];
          for await (const line of readLines(path)) lines.push(line);
          const records = parseAntigravityLines(lines, where.conversation, ws.get(where.conversation));
          this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, records, rateLimits: null });
        } else {
          const lines: string[] = [];
          for await (const line of readLines(path)) {
            if (line.includes('"token_count"') || line.includes('"turn_context"') || line.includes('"session_meta"')) lines.push(line);
          }
          const { records, rateLimits } = parseCodexLines(lines, path);
          this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, records, rateLimits });
        }
      } catch {
        /* unreadable file: skip, retry next scan */
      }
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
  }

  /** All records, deduped (Claude repeats a message across lines and resumed sessions). */
  records(): UsageRecord[] {
    const out: UsageRecord[] = [...this.opencodeRecords];
    const keys = new Set<string>();
    for (const f of this.files.values()) {
      for (const r of f.records) {
        if (r.key && r.key !== ":") {
          if (keys.has(r.key)) continue;
          keys.add(r.key);
        }
        out.push(r);
      }
    }
    return out;
  }

  codexRateLimits(): CodexRateLimits | null {
    let best: CodexRateLimits | null = null;
    for (const f of this.files.values()) if (f.rateLimits && (!best || f.rateLimits.ts > best.ts)) best = f.rateLimits;
    return best;
  }
}

/** Read completed OpenCode Go assistant messages from the local database. */
function readOpenCode(dir?: string): UsageRecord[] {
  if (!dir || !existsSync(join(dir, "opencode.db"))) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(dir, "opencode.db"), { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
    const records: UsageRecord[] = [];
    for (const [message, session, v2] of [["message", "session", false], ["session_message", "session_v2", true]] as const) {
      if (!tables.has(message) || !tables.has(session)) continue;
      const rows = db.prepare(`SELECT m.id, m.time_created, m.data, s.directory FROM ${message} m JOIN ${session} s ON s.id = m.session_id${v2 ? " WHERE m.type = 'assistant'" : ""}`).all();
      for (const row of rows) {
        try {
          const data = JSON.parse(String(row.data));
          const model = v2 ? data.model : { providerID: data.providerID, id: data.modelID };
          if ((v2 ? data.model : data.role === "assistant") && model?.providerID === "opencode-go" && typeof model.id === "string" && data.tokens) {
            records.push({ agent: "opencode-go", key: `opencode:${row.id}`, ts: Number(row.time_created), model: model.id, cwd: String(row.directory ?? ""), input: num(data.tokens.input), output: num(data.tokens.output), cacheRead: num(data.tokens.cache?.read), cacheWrite5m: num(data.tokens.cache?.write), cacheWrite1h: 0 });
          }
        } catch { /* Ignore malformed messages. */ }
      }
    }
    return records;
  } catch { return []; } finally { db?.close(); }
}

// ---- quota ----

export interface QuotaWindow {
  label: string;
  used_percent: number;
  resets_ms: number | null;
}
/** Antigravity draws on the Google quota; it has no quota of its own. */
export type QuotaAgent = Exclude<UsageAgent, "antigravity"> | "google";

export interface AgentQuota {
  agent: QuotaAgent;
  /** Where the numbers come from + when they were captured. */
  source: string;
  as_of_ms: number | null;
  /** True when the snapshot predates a window reset (numbers are out of date). */
  stale: boolean;
  plan: string | null;
  windows: QuotaWindow[];
  note: string | null;
}

/** Quota placeholder for "the upstream could not be asked" — never an error,
 *  the page just shows the note. */
export function emptyGoQuota(note: string): AgentQuota {
  return { agent: "opencode-go", source: "OpenCode Go", as_of_ms: null, stale: true, plan: null, windows: [], note };
}

/** How long a good snapshot stays fresh and how long a failure is remembered
 *  (enough to stop a poll loop from hammering, short enough to recover). */
const QUOTA_TTL_MS = 60_000;
const QUOTA_ERROR_TTL_MS = 10_000;

/** External quota sources are polled by the Usage page while it scans: one
 *  call is shared and the result is cached, so polls never fan out upstream
 *  and a slow upstream never delays the report. */
export interface QuotaCacheOptions {
  fetchQuota: () => Promise<AgentQuota>;
  empty: (note: string) => AgentQuota;
  errorNote: string;
  slowNote: string;
  clock?: () => number;
  timeoutMs?: number;
}

export class QuotaCache {
  private cache: { at: number; ttl: number; value: AgentQuota } | null = null;
  private inflight: Promise<AgentQuota> | null = null;
  private options: QuotaCacheOptions;
  private clock: () => number;

  constructor(options: QuotaCacheOptions) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
  }

  async get(force = false): Promise<AgentQuota> {
    const now = this.clock();
    if (!force && this.cache && now - this.cache.at < this.cache.ttl) return this.cache.value;
    this.inflight ??= this.options.fetchQuota()
      .catch(() => this.options.empty(this.options.errorNote))
      .then((value) => {
        const ok = value.as_of_ms !== null;
        this.cache = { at: this.clock(), ttl: ok ? QUOTA_TTL_MS : QUOTA_ERROR_TTL_MS, value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return withDeadline(this.inflight, this.options.timeoutMs ?? 2500, this.options.empty(this.options.slowNote));
  }
}

/** OpenCode Go quota is behind an external HTTPS call. */
export class GoQuotaCache extends QuotaCache {
  constructor(options: { fetchQuota?: () => Promise<AgentQuota>; clock?: () => number } = {}) {
    super({
      fetchQuota: options.fetchQuota ?? (() => opencodeGoQuota()),
      empty: emptyGoQuota,
      errorNote: "Could not reach OpenCode Go quota service.",
      slowNote: "OpenCode Go quota is slow — retrying shortly.",
      clock: options.clock,
    });
  }
}

/** Account-wide Go quota, using the credential registered with OpenCode. */
export async function opencodeGoQuota(dir = process.env.OPENCODE_DATA_DIR || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode"), fetcher: typeof fetch = fetch, now = Date.now()): Promise<AgentQuota> {
  const empty = emptyGoQuota;
  let key: unknown;
  try { key = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"))["opencode-go"]?.key; } catch { return empty("Connect OpenCode Go in OpenCode to see quota."); }
  if (typeof key !== "string" || !key) return empty("Connect OpenCode Go in OpenCode to see quota.");
  try {
    const response = await fetcher("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) return empty(`OpenCode Go quota unavailable (HTTP ${response.status}).`);
    const data = await response.json() as any;
    const windows: QuotaWindow[] = [];
    for (const [name, label] of [["rolling", "5-hour session"], ["weekly", "Weekly"], ["monthly", "Monthly"]]) {
      const w = data?.usage?.[name];
      const reset = typeof w?.resetsAt === "string" ? Date.parse(w.resetsAt) : NaN;
      if (!w || !["ok", "rate-limited"].includes(w.status) || typeof w.percent !== "number" || !Number.isFinite(w.percent) || !Number.isFinite(reset)) return empty("OpenCode Go returned an invalid quota response.");
      windows.push({ label, used_percent: Math.max(0, Math.min(100, w.percent)), resets_ms: reset });
    }
    return { agent: "opencode-go", source: "OpenCode Go", as_of_ms: now, stale: windows.some(w => w.resets_ms !== null && w.resets_ms < now), plan: null, windows, note: null };
  } catch { return empty("Could not reach OpenCode Go quota service."); }
}

/** Claude quota from ccstatusline's cache (the freshest usage*.json). */
export function claudeQuota(dir: string, now = Date.now()): AgentQuota {
  const empty: AgentQuota = {
    agent: "claude",
    source: "ccstatusline cache",
    as_of_ms: null,
    stale: true,
    plan: null,
    windows: [],
    note: "No quota snapshot — enable ccstatusline's usage widgets in Claude Code.",
  };
  if (!existsSync(dir)) return empty;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!/^usage.*\.json$/.test(name)) continue;
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  if (!best) return empty;
  let d: Record<string, any>;
  try {
    d = JSON.parse(readFileSync(best.path, "utf8"));
  } catch {
    return empty;
  }
  const windows: QuotaWindow[] = [];
  const reset = (v: unknown) => (typeof v === "string" ? Date.parse(v) || null : null);
  if (typeof d.sessionUsage === "number") windows.push({ label: "5-hour session", used_percent: d.sessionUsage, resets_ms: reset(d.sessionResetAt) });
  if (typeof d.weeklyUsage === "number") windows.push({ label: "Weekly (all models)", used_percent: d.weeklyUsage, resets_ms: reset(d.weeklyResetAt) });
  if (num(d.weeklyOpusUsage) > 0) windows.push({ label: "Weekly Opus", used_percent: d.weeklyOpusUsage, resets_ms: reset(d.weeklyResetAt) });
  if (num(d.weeklySonnetUsage) > 0) windows.push({ label: "Weekly Sonnet", used_percent: d.weeklySonnetUsage, resets_ms: reset(d.weeklyResetAt) });
  const stale = windows.some((w) => w.resets_ms !== null && w.resets_ms < now);
  const extra = d.extraUsageEnabled ? "Extra usage enabled: requests continue past the limits, billed separately." : null;
  return { agent: "claude", source: "ccstatusline cache", as_of_ms: best.mtime, stale, plan: null, windows, note: extra };
}

export function windowLabel(minutes: number): string {
  if (minutes >= 10080 && minutes % 10080 === 0) return minutes === 10080 ? "Weekly" : `${minutes / 10080}-week`;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export function codexQuota(rl: CodexRateLimits | null, now = Date.now()): AgentQuota {
  if (!rl) {
    return { agent: "codex", source: "Codex session logs", as_of_ms: null, stale: true, plan: null, windows: [], note: "No Codex session with rate limits yet." };
  }
  const windows: QuotaWindow[] = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (w) windows.push({ label: windowLabel(w.window_minutes), used_percent: w.used_percent, resets_ms: w.resets_at });
  }
  const stale = windows.some((w) => w.resets_ms !== null && w.resets_ms < now);
  return { agent: "codex", source: "Codex session logs", as_of_ms: rl.ts, stale, plan: rl.plan, windows, note: null };
}

// ---- aggregation ----

export type UsageRange = "24h" | "7d" | "30d" | "all";
export const USAGE_RANGES: UsageRange[] = ["24h", "7d", "30d", "all"];

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Estimated USD over priced records. */
  cost_usd: number;
  /** Calls whose model has no price. */
  unpriced_calls: number;
}

/** One bar of the Over time chart: spend and tokens split by agent and by model. */
export interface UsageTimelineBucket {
  start_ms: number;
  claude: number;
  codex: number;
  claude_tokens: number;
  codex_tokens: number;
  opencode_go: number;
  opencode_go_tokens: number;
  antigravity: number;
  antigravity_tokens: number;
  /** Unpriced calls add tokens but no cost. */
  models: { agent: UsageAgent; model: string; cost_usd: number; tokens: number }[];
}

export interface UsageReport {
  range: UsageRange;
  since_ms: number | null;
  generated_ms: number;
  scanning: boolean;
  totals: UsageTotals;
  by_agent: ({ agent: UsageAgent } & UsageTotals)[];
  by_model: ({ agent: UsageAgent; model: string; priced: boolean } & UsageTotals)[];
  /** Buckets: hourly for 24h, daily otherwise (local time). */
  timeline: UsageTimelineBucket[];
  bucket: "hour" | "day";
  efficiency: {
    /** Tasks with spend in range. */
    tasks_with_spend: number;
    /** Of those, tasks done/archived. */
    tasks_done: number;
    attributed_usd: number;
    unattributed_usd: number;
    /** Done tasks per USD of attributed spend; null without spend. */
    tasks_per_usd: number | null;
    usd_per_done_task: number | null;
    top_tasks: { id: string; title: string; status: string; agent: UsageAgent | "mixed"; cost_usd: number; tokens: number }[];
  };
}

function emptyTotals(): UsageTotals {
  return { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0, unpriced_calls: 0 };
}

function emptyBucket(start_ms: number): UsageTimelineBucket {
  return { start_ms, claude: 0, codex: 0, claude_tokens: 0, codex_tokens: 0, opencode_go: 0, opencode_go_tokens: 0, antigravity: 0, antigravity_tokens: 0, models: [] };
}

function add(t: UsageTotals, r: UsageRecord, cost: number | null): void {
  t.calls++;
  t.input += r.input;
  t.output += r.output;
  t.cache_read += r.cacheRead;
  t.cache_write += r.cacheWrite5m + r.cacheWrite1h;
  if (cost === null) t.unpriced_calls++;
  else t.cost_usd += cost;
}

const tokensOf = (r: UsageRecord) => r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;

function bucketStart(ts: number, bucket: "hour" | "day"): number {
  const d = new Date(ts);
  if (bucket === "hour") d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The task whose worktree contains cwd (longest match). */
function taskForCwd(cwd: string, tasks: Task[]): Task | null {
  let best: Task | null = null;
  for (const t of tasks) {
    const w = t.worktree_path;
    if (!w) continue;
    if ((cwd === w || cwd.startsWith(w.endsWith("/") ? w : w + "/")) && (!best || w.length > (best.worktree_path?.length ?? 0))) best = t;
  }
  return best;
}

export function buildReport(input: {
  records: UsageRecord[];
  tasks: Task[];
  prices: Record<string, ModelPrice>;
  range: UsageRange;
  scanning: boolean;
  now?: number;
}): UsageReport {
  const now = input.now ?? Date.now();
  const spans: Record<UsageRange, number | null> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, all: null };
  const span = spans[input.range];
  const since = span === null ? null : now - span;
  const bucket = input.range === "24h" ? "hour" : "day";

  const totals = emptyTotals();
  const byAgent = new Map<UsageAgent, UsageTotals>();
  const byModel = new Map<string, { agent: UsageAgent; model: string; priced: boolean } & UsageTotals>();
  const timeline = new Map<number, UsageTimelineBucket>();
  const perTask = new Map<string, { task: Task; cost: number; tokens: number; agents: Set<UsageAgent> }>();
  let attributed = 0;
  let unattributed = 0;
  const cwdTask = new Map<string, Task | null>();

  for (const r of input.records) {
    if (since !== null && r.ts < since) continue;
    const cost = recordCost(r, input.prices);
    add(totals, r, cost);
    let a = byAgent.get(r.agent);
    if (!a) byAgent.set(r.agent, (a = emptyTotals()));
    add(a, r, cost);
    const mk = `${r.agent}\u0000${r.model}`;
    let m = byModel.get(mk);
    if (!m) byModel.set(mk, (m = { agent: r.agent, model: r.model, priced: cost !== null, ...emptyTotals() }));
    add(m, r, cost);

    const b = bucketStart(r.ts, bucket);
    let tl = timeline.get(b);
    if (!tl) timeline.set(b, (tl = emptyBucket(b)));
    const agent = r.agent === "opencode-go" ? "opencode_go" : r.agent;
    tl[agent] += cost ?? 0;
    tl[`${agent}_tokens`] += tokensOf(r);
    let mt = tl.models.find((m) => m.agent === r.agent && m.model === r.model);
    if (!mt) tl.models.push((mt = { agent: r.agent, model: r.model, cost_usd: 0, tokens: 0 }));
    mt.cost_usd += cost ?? 0;
    mt.tokens += tokensOf(r);

    if (!cwdTask.has(r.cwd)) cwdTask.set(r.cwd, r.cwd ? taskForCwd(r.cwd, input.tasks) : null);
    const task = cwdTask.get(r.cwd) ?? null;
    if (task) {
      let pt = perTask.get(task.id);
      if (!pt) perTask.set(task.id, (pt = { task, cost: 0, tokens: 0, agents: new Set() }));
      pt.cost += cost ?? 0;
      pt.tokens += tokensOf(r);
      pt.agents.add(r.agent);
      attributed += cost ?? 0;
    } else {
      unattributed += cost ?? 0;
    }
  }

  // Fill empty buckets so the chart has a continuous axis.
  const filled: UsageReport["timeline"] = [];
  const keys = [...timeline.keys()].sort((x, y) => x - y);
  if (keys.length) {
    let cur = since !== null ? bucketStart(since, bucket) : keys[0];
    const end = bucketStart(now, bucket);
    while (cur <= end) {
      filled.push(timeline.get(cur) ?? emptyBucket(cur));
      const d = new Date(cur);
      if (bucket === "hour") d.setHours(d.getHours() + 1);
      else d.setDate(d.getDate() + 1);
      cur = d.getTime();
    }
  }

  const tasksWithSpend = [...perTask.values()];
  const done = tasksWithSpend.filter((t) => t.task.status === "done" || t.task.status === "archived");
  const doneCost = done.reduce((s, t) => s + t.cost, 0);
  return {
    range: input.range,
    since_ms: since,
    generated_ms: now,
    scanning: input.scanning,
    totals,
    by_agent: [...byAgent.entries()].map(([agent, t]) => ({ agent, ...t })).sort((x, y) => y.cost_usd - x.cost_usd),
    by_model: [...byModel.values()].sort((x, y) => y.cost_usd - x.cost_usd || y.output - x.output),
    timeline: filled.map((b) => ({ ...b, models: b.models.sort((x, y) => y.cost_usd - x.cost_usd || x.model.localeCompare(y.model)) })),
    bucket,
    efficiency: {
      tasks_with_spend: tasksWithSpend.length,
      tasks_done: done.length,
      attributed_usd: attributed,
      unattributed_usd: unattributed,
      tasks_per_usd: attributed > 0 ? done.length / attributed : null,
      usd_per_done_task: done.length > 0 ? doneCost / done.length : null,
      top_tasks: tasksWithSpend
        .sort((x, y) => y.cost - x.cost)
        .slice(0, 10)
        .map((t) => ({
          id: t.task.id,
          title: t.task.title || t.task.prompt.split("\n")[0].slice(0, 80),
          status: t.task.status,
          agent: t.agents.size > 1 ? "mixed" : [...t.agents][0],
          cost_usd: t.cost,
          tokens: t.tokens,
        })),
    },
  };
}

/** Compact all-time-in-window usage for the improvement digest: totals plus
 *  per-task attribution, without the chart timeline the Usage page needs. */
export interface UsageEvidence {
  since_ms: number;
  generated_ms: number;
  scanning: boolean;
  totals: UsageTotals;
  by_agent: ({ agent: UsageAgent } & UsageTotals)[];
  by_model: ({ agent: UsageAgent; model: string; priced: boolean } & UsageTotals)[];
  by_task: {
    id: string;
    title: string;
    status: string;
    agents: UsageAgent[];
    models: string[];
    cost_usd: number;
    tokens: number;
    unpriced_calls: number;
  }[];
  attributed_usd: number;
  unattributed_usd: number;
}

export function buildUsageEvidence(input: {
  records: UsageRecord[];
  tasks: Task[];
  prices: Record<string, ModelPrice>;
  since_ms: number;
  scanning?: boolean;
  now?: number;
}): UsageEvidence {
  const totals = emptyTotals();
  const byAgent = new Map<UsageAgent, UsageTotals>();
  const byModel = new Map<string, { agent: UsageAgent; model: string; priced: boolean } & UsageTotals>();
  const perTask = new Map<string, { task: Task; cost: number; tokens: number; unpriced: number; agents: Set<UsageAgent>; models: Set<string> }>();
  const cwdTask = new Map<string, Task | null>();
  let attributed = 0;
  let unattributed = 0;

  for (const r of input.records) {
    if (r.ts < input.since_ms) continue;
    const cost = recordCost(r, input.prices);
    add(totals, r, cost);
    let a = byAgent.get(r.agent);
    if (!a) byAgent.set(r.agent, (a = emptyTotals()));
    add(a, r, cost);
    const mk = `${r.agent}\u0000${r.model}`;
    let m = byModel.get(mk);
    if (!m) byModel.set(mk, (m = { agent: r.agent, model: r.model, priced: cost !== null, ...emptyTotals() }));
    add(m, r, cost);

    if (!cwdTask.has(r.cwd)) cwdTask.set(r.cwd, r.cwd ? taskForCwd(r.cwd, input.tasks) : null);
    const task = cwdTask.get(r.cwd) ?? null;
    if (!task) {
      unattributed += cost ?? 0;
      continue;
    }
    let pt = perTask.get(task.id);
    if (!pt) perTask.set(task.id, (pt = { task, cost: 0, tokens: 0, unpriced: 0, agents: new Set(), models: new Set() }));
    pt.cost += cost ?? 0;
    pt.tokens += tokensOf(r);
    pt.agents.add(r.agent);
    pt.models.add(r.model);
    if (cost === null) pt.unpriced++;
    attributed += cost ?? 0;
  }

  return {
    since_ms: input.since_ms,
    generated_ms: input.now ?? Date.now(),
    scanning: input.scanning === true,
    totals,
    by_agent: [...byAgent.entries()].map(([agent, t]) => ({ agent, ...t })).sort((x, y) => y.cost_usd - x.cost_usd),
    by_model: [...byModel.values()].sort((x, y) => y.cost_usd - x.cost_usd || y.output - x.output),
    by_task: [...perTask.values()]
      .sort((x, y) => y.cost - x.cost)
      .map((t) => ({
        id: t.task.id,
        title: taskLabel(t.task),
        status: t.task.status,
        agents: [...t.agents],
        models: [...t.models],
        cost_usd: t.cost,
        tokens: t.tokens,
        unpriced_calls: t.unpriced,
      })),
    attributed_usd: attributed,
    unattributed_usd: unattributed,
  };
}
