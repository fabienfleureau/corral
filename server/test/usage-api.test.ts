// The Usage page must paint its cards before slow sources answer: the report
// has no external quota calls, and quota has its own endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppState } from "../api.ts";
import { Db } from "../db.ts";
import { GoQuotaCache, UsageScanner, emptyGoQuota } from "../usage.ts";
import { GoogleQuotaCache, emptyGoogleQuota } from "../google-quota.ts";

async function withServer(state: AppState, run: (base: string) => Promise<void>) {
  const { createHttpServer } = await import("../api.ts");
  const server = createHttpServer(state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    state.db.close();
  }
}

function stateWith(dir: string, go: GoQuotaCache, google: GoogleQuotaCache): AppState {
  return {
    db: new Db(":memory:"),
    cfg: { token: "test" },
    hub: { broadcast() {}, clients: new Set() },
    usage: new UsageScanner({ claudeDir: dir, codexDir: dir, claudeQuotaDir: dir }),
    goQuota: go,
    googleQuota: google,
  } as never as AppState;
}

const never = () => new Promise<never>(() => undefined);

test("GET /api/usage answers without waiting for external quota sources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-usage-api-"));
  const state = stateWith(dir, new GoQuotaCache({ fetchQuota: never }), new GoogleQuotaCache({ fetchQuota: never }));
  await withServer(state, async (base) => {
    const started = Date.now();
    const response = await fetch(`${base}/api/usage?range=7d&refresh=1`, { headers: { Authorization: "Bearer test" } });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.ok(Date.now() - started < 1000, "a stalled quota source must not delay the report");
    assert.equal("quota" in body, false);
    assert.equal(typeof body.scanning, "boolean");
    assert.ok(body.totals);
  });
  rmSync(dir, { recursive: true, force: true });
});

test("GET /api/usage/quota returns a card for every agent, with notes when sources are absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-quota-api-"));
  const state = stateWith(
    dir,
    new GoQuotaCache({ fetchQuota: async () => emptyGoQuota("Go is not connected.") }),
    new GoogleQuotaCache({ fetchQuota: async () => emptyGoogleQuota("Antigravity is not running.") }),
  );
  await withServer(state, async (base) => {
    const response = await fetch(`${base}/api/usage/quota`, { headers: { Authorization: "Bearer test" } });
    const body = (await response.json()) as { quota: { agent: string; note: string | null; windows: unknown[] }[]; fetched_ms: number };
    assert.equal(response.status, 200);
    assert.deepEqual(body.quota.map((q) => q.agent), ["claude", "codex", "opencode-go", "google"]);
    assert.equal(body.quota[2].note, "Go is not connected.");
    assert.equal(body.quota[3].note, "Antigravity is not running.");
    assert.ok(body.quota.every((q) => Array.isArray(q.windows)));
    assert.ok(body.fetched_ms > 0);
  });
  rmSync(dir, { recursive: true, force: true });
});
