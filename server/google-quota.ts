// Google quota comes from CodexBar, which owns the Gemini / Antigravity
// account session. Corral never reads or stores Google credentials.

import { homedir } from "node:os";
import { join } from "node:path";
import { resolveExecutable, runAsync } from "./exec.ts";
import { QuotaCache, windowLabel, type AgentQuota, type QuotaWindow } from "./usage.ts";

export const GOOGLE_PROVIDERS = ["gemini", "antigravity"] as const;

type Json = Record<string, any>;
type Run = (cmd: string, args: string[], opts?: { timeout?: number; allowFailure?: boolean }) => Promise<string>;

export function emptyGoogleQuota(note: string): AgentQuota {
  return { agent: "google", source: "CodexBar · Google", as_of_ms: null, stale: true, plan: null, windows: [], note };
}

function ms(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function windowFrom(raw: Json | null | undefined, label: string): QuotaWindow | null {
  if (!raw || typeof raw.usedPercent !== "number" || !Number.isFinite(raw.usedPercent) || raw.isSyntheticPlaceholder === true) return null;
  return { label, used_percent: Math.max(0, Math.min(100, raw.usedPercent)), resets_ms: ms(raw.resetsAt) };
}

function windowName(payload: Json, key: string, raw: Json, index: number): string {
  const label = payload.rateWindowLabels?.[key] ?? raw.title;
  if (typeof label === "string" && label.trim()) return label.trim();
  const generated = typeof raw.windowMinutes === "number" ? windowLabel(raw.windowMinutes) : "";
  return generated || `Window ${index + 1}`;
}

/** Parse `codexbar usage --provider ... --format json` output. One CLI call
 *  prints an array of payloads and exits non-zero even when it has a JSON
 *  error report, so failures are parsed as notes instead of thrown away. */
export function parseCodexBarQuota(outputs: string[], now = Date.now()): AgentQuota {
  const notes: string[] = [];
  let best: { windows: QuotaWindow[]; source: string; as_of_ms: number | null; plan: string | null } | null = null;
  for (const output of outputs) {
    let payloads: unknown;
    try {
      payloads = JSON.parse(output);
    } catch {
      continue;
    }
    if (!Array.isArray(payloads)) continue;
    for (const item of payloads) {
      const payload = item as Json;
      if (!GOOGLE_PROVIDERS.includes(payload?.provider)) continue;
      const usage = (payload.usage ?? {}) as Json;
      const keys = ["primary", "secondary", "tertiary"];
      let windows = keys.flatMap((key, i) => {
        const raw = usage[key] as Json | undefined;
        const w = windowFrom(raw, windowName(payload, key, raw ?? {}, i));
        return w ? [w] : [];
      });
      if (!windows.length && Array.isArray(usage.extraRateWindows)) {
        // Antigravity reports a quota per model family in named extra windows.
        windows = usage.extraRateWindows.flatMap((e: Json, i: number) => {
          const raw = e?.window as Json | undefined;
          const label = typeof e?.title === "string" && e.title.trim() ? e.title : String(e?.id ?? `Window ${i + 1}`);
          const w = windowFrom(raw, label);
          return w ? [w] : [];
        });
      }
      if (windows.length) {
        if (!best) {
          const identity = (usage.identity ?? {}) as Json;
          const plan = typeof identity.loginMethod === "string" && identity.loginMethod.trim()
            ? identity.loginMethod.trim()
            : typeof payload.status?.description === "string" && payload.status.description.trim()
              ? payload.status.description.trim()
              : null;
          best = {
            windows,
            source: `CodexBar · ${payload.provider === "gemini" ? "Gemini" : "Antigravity"}`,
            as_of_ms: ms(usage.updatedAt) ?? ms(payload.status?.updatedAt) ?? now,
            plan,
          };
        }
        continue;
      }
      const message = typeof payload.error?.message === "string" && payload.error.message.trim()
        ? payload.error.message.trim()
        : `no ${payload.provider} quota reported`;
      notes.push(message);
    }
  }
  if (!best) {
    return emptyGoogleQuota(notes.length
      ? `CodexBar: ${[...new Set(notes)].join(" · ")}`
      : "Enable Gemini or Antigravity in CodexBar to see Google quota here.");
  }
  return {
    agent: "google",
    source: best.source,
    as_of_ms: best.as_of_ms,
    stale: best.windows.some((w) => w.resets_ms !== null && w.resets_ms < now),
    plan: best.plan,
    windows: best.windows,
    note: null,
  };
}

export function resolveCodexBar(): string | null {
  const home = homedir();
  return resolveExecutable("codexbar", [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]);
}

/** Ask both Google providers in parallel: either one can carry the quota for
 *  the account, and a disabled or unconfigured provider must not hide the
 *  other. The CLI is cached by GoogleQuotaCache. */
export async function googleQuota(options: { run?: Run; executable?: string | null; now?: number } = {}): Promise<AgentQuota> {
  const executable = options.executable === undefined ? resolveCodexBar() : options.executable;
  if (!executable) return emptyGoogleQuota("Install CodexBar to see Google quota.");
  const run = options.run ?? ((cmd: string, args: string[], opts?: { timeout?: number; allowFailure?: boolean }) => runAsync(cmd, args, opts));
  const outputs = await Promise.all(GOOGLE_PROVIDERS.map(async (provider) => {
    try {
      return await run(executable, ["usage", "--provider", provider, "--format", "json", "--no-color"], { timeout: 8000, allowFailure: true });
    } catch {
      return "";
    }
  }));
  return parseCodexBarQuota(outputs, options.now ?? Date.now());
}

/** One CodexBar call per minute, shared by concurrent polls. */
export class GoogleQuotaCache extends QuotaCache {
  constructor(options: { fetchQuota?: () => Promise<AgentQuota>; clock?: () => number } = {}) {
    super({
      fetchQuota: options.fetchQuota ?? (() => googleQuota()),
      empty: emptyGoogleQuota,
      errorNote: "Could not reach CodexBar for Google quota.",
      slowNote: "Google quota is slow — retrying shortly.",
      clock: options.clock,
      timeoutMs: 10_000,
    });
  }
}
