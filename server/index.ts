// Corral server entry point: config -> db -> worker backend -> HTTP.

import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { OmnigentBackend } from "./omnigent.ts";
import { CaptureEngine } from "./capture.ts";
import { JiraClient } from "./jira.ts";
import { prCandidateTasks, syncTaskPr } from "./pr.ts";
import { refreshPulls } from "./pulls.ts";
import { createHttpServer, type AppState } from "./api.ts";
import type { ServerResponse } from "node:http";

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

const capture = new CaptureEngine(db, backend, hub, cfg);
const state: AppState = { db, cfg, backend, capture, jira, hub };

// Worker events (omnigent polling loop) drive the inbox.
const subscription = backend.onEvent((e) => void capture.handleEvent(e));

// PR discovery + the PR loop: find review links, feed comments back to agents.
setInterval(() => {
  for (const task of prCandidateTasks(db)) {
    try {
      syncTaskPr(db, hub, task, { backend, cfg });
    } catch {
      /* best effort */
    }
  }
}, 120_000);

// Pull Requests page: refresh where the human is awaited (GitHub + GitLab).
setTimeout(() => {
  try {
    refreshPulls();
  } catch {
    /* best effort */
  }
}, 3_000);
setInterval(() => {
  try {
    refreshPulls();
  } catch {
    /* best effort */
  }
}, 180_000);

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
