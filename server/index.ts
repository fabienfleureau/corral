// Corral server entry point: config -> db -> worker backend -> HTTP.

import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { OmnigentBackend } from "./omnigent.ts";
import { CaptureEngine } from "./capture.ts";
import { JiraClient } from "./jira.ts";
import { prCandidateTasks, syncAllPrs, syncTaskPr } from "./pr.ts";
import { refreshPulls } from "./pulls.ts";
import { createHttpServer, type AppState } from "./api.ts";
import { SessionFacts } from "./session-facts.ts";
import type { ServerResponse } from "node:http";
import { DEFAULT_PRICES, UsageScanner, defaultSources } from "./usage.ts";
import { ImprovementAnalysis } from "./improvement.ts";
import { llmComplete } from "./llm.ts";
import { withDeadline } from "./deadline.ts";

const cfg = loadConfig();
const db = new Db(join(cfg.dataDir, "corral.db"));
const backend = new OmnigentBackend(cfg.omnigent);
const jira = new JiraClient(cfg.jira);

const clients = new Set<ServerResponse>();
const hub = {
  clients,
  broadcast(type: string, data: unknown) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  },
};

const capture = new CaptureEngine(db, backend, hub, cfg, jira);
const usage = new UsageScanner(defaultSources());
const improvement = new ImprovementAnalysis(db, hub, (prompt) => llmComplete(cfg, prompt), {
  usage: async () => {
    // A first scan of large logs can take a while: the digest still gets the
    // records indexed so far and marks the snapshot as scanning.
    await withDeadline(usage.refresh(), 15_000, undefined);
    return {
      records: usage.records(),
      prices: { ...DEFAULT_PRICES, ...(cfg.usage?.prices ?? {}) },
      scanning: !usage.ready,
    };
  },
});
const sessionFacts = new SessionFacts(backend);
const state: AppState = { db, cfg, backend, capture, jira, hub, usage, improvement, sessionFacts };
setTimeout(() => void improvement.runIfDue().catch(() => undefined), 10_000);
setInterval(() => void improvement.runIfDue().catch(() => undefined), 60_000);
// Tasks page: the queue's session model/reasoning costs one backend round trip
// per task. Read them once in the background so the first list load is warm.
setTimeout(() => void sessionFacts.prime(db.listTasks()).catch(() => undefined), 1_000);
// Usage page: warm the log scan so the first visit is fast.
setTimeout(() => void usage.refresh().catch(() => undefined), 5_000);

// Worker events (omnigent polling loop) drive the inbox.
const subscription = backend.onEvent((e) => void capture.handleEvent(e));

// PR discovery + the PR loop: find review links, feed comments back to agents.
setInterval(() => void syncAllPrs(db, hub, { backend, cfg, jira }, 0).catch(() => undefined), 120_000);

// Pull Requests page: refresh where the human is awaited (GitHub + GitLab).
// Best effort; each refresh broadcasts "pulls.updated" so open pages reload.
setTimeout(() => void refreshPulls(hub).catch(() => undefined), 3_000);
setInterval(() => void refreshPulls(hub).catch(() => undefined), 180_000);

const server = createHttpServer(state);
server.listen(cfg.port, cfg.host, () => {
  console.log(`corral listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  backend: ${backend.name} (${cfg.omnigent.baseUrl})`);
  console.log(`  token: ${cfg.token.slice(0, 4)}… (in ${join(cfg.configDir, "config.json")})`);
  console.log(`  open:  http://${cfg.host}:${cfg.port}/?token=${cfg.token}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("\ncorral: shutting down");
    subscription.stop();
    server.close();
    db.close();
    process.exit(0);
  });
}
