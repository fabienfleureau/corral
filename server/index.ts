// Corral server entry point: config -> db -> herdr streams -> HTTP.

import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { HerdrClient, HerdrEventStream } from "./herdr.ts";
import { CaptureEngine } from "./capture.ts";
import { JiraClient } from "./jira.ts";
import { prCandidateTasks, syncTaskPr } from "./pr.ts";
import { createHttpServer, type AppState } from "./api.ts";
import type { ServerResponse } from "node:http";

const cfg = loadConfig();
const db = new Db(join(cfg.dataDir, "corral.db"));
const herdr = new HerdrClient(cfg.herdrSocket);
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

const capture = new CaptureEngine(db, herdr, hub, cfg);
const state: AppState = { db, cfg, herdr, capture, jira, hub };

const stream = new HerdrEventStream({
  onEvent: (e) => void capture.handleEvent(e),
  onStatus: (err) => {
    if (err) console.error("corral:", err.message);
    else console.log("corral: herdr event stream connected");
  },
});
stream.start();

// Safety net for missed events.
setInterval(() => void capture.reconcile(), 30_000);

// PR discovery + the PR loop: find review links, feed comments back to agents.
setInterval(() => {
  for (const task of prCandidateTasks(db)) {
    try {
      syncTaskPr(db, hub, task, { herdr, cfg });
    } catch {
      /* best effort */
    }
  }
}, 120_000);

const server = createHttpServer(state);
server.listen(cfg.port, cfg.host, () => {
  console.log(`corral listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  token: ${cfg.token.slice(0, 4)}… (in ${join(cfg.configDir, "config.json")})`);
  console.log(`  open:  http://${cfg.host}:${cfg.port}/?token=${cfg.token}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("\ncorral: shutting down");
    stream.stop();
    server.close();
    db.close();
    process.exit(0);
  });
}
