// Local model server probe (the GPU box). A model id like
// "ornith-local/ornith-1.5-35b-a3b" is served by a base URL the backend knows
// (/models on an OpenAI-compatible server); asking it is the only honest way to
// say whether that model is available right now.
//
// 2 s timeout, 30 s cache: the Tasks page polls this on load, the GPU box is on
// the LAN, and a reload must never wait on it. A timeout stays UNKNOWN — never
// "down": not answering is not the same as not existing.

import type { ModelAvailability } from "./worker.ts";

export interface LocalModelProbeOptions {
  /** Whole-request budget; the default matches the backend contract (2 s). */
  timeoutMs?: number;
  ttlMs?: number;
  clock?: () => number;
  fetch?: typeof fetch;
}

export const PROBE_TIMEOUT_MS = 2000;
export const PROBE_TTL_MS = 30_000;

export class LocalModelProbe {
  private cache = new Map<string, { at: number; value: ModelAvailability }>();
  private timeoutMs: number;
  private ttlMs: number;
  private clock: () => number;
  private fetchImpl: typeof fetch;

  constructor(options: LocalModelProbeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.ttlMs = options.ttlMs ?? PROBE_TTL_MS;
    this.clock = options.clock ?? Date.now;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Cached (30 s) availability of a local model server, keyed by base URL. */
  async availability(baseUrl: string): Promise<ModelAvailability> {
    const now = this.clock();
    const cached = this.cache.get(baseUrl);
    if (cached && now - cached.at < this.ttlMs) return cached.value;
    const value = await this.probe(baseUrl);
    this.cache.set(baseUrl, { at: this.clock(), value });
    return value;
  }

  private async probe(baseUrl: string): Promise<ModelAvailability> {
    let url: URL;
    try {
      url = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    } catch {
      return { status: "unknown", models: [] };
    }
    try {
      const res = await this.fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { status: "down", models: [] };
      const body = (await res.json()) as { data?: unknown; models?: unknown };
      return { status: "up", models: modelIds(body) };
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      // A timeout (or an aborted request) tells us nothing about the model list.
      return { status: name === "TimeoutError" || name === "AbortError" ? "unknown" : "down", models: [] };
    }
  }
}

/** OpenAI-compatible `{data: [{id}]}` and llama.cpp's `{models: [...]}`. */
function modelIds(body: { data?: unknown; models?: unknown }): string[] {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return rows
    .map((row) => (typeof row === "string" ? row : (row as { id?: unknown; name?: unknown })?.id ?? (row as { name?: unknown })?.name))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}
