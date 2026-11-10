// Screenshot-only stand-in for omnigent's REST API. Corral's harness catalog
// reads `/v1/agents`, `/v1/hosts` and the per-harness `model-options`; this
// serves exactly those, from a fixed synthetic catalog, so benchmark captures
// are deterministic and never touch a real host.

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const AGENTS = [
  { id: "fixture-claude", name: "Claude Code", harness: "claude-native" },
  { id: "fixture-codex", name: "Codex", harness: "codex-native" },
  { id: "fixture-opencode", name: "OpenCode", harness: "opencode-native" },
];

type StubModel = { id: string; label: string; reasoning: string[] };

const REASONING = ["low", "medium", "high", "xhigh", "max"];

const MODELS: Record<string, StubModel[]> = {
  claude: [
    { id: "opus", label: "Opus", reasoning: REASONING },
    { id: "sonnet", label: "Sonnet", reasoning: REASONING },
    { id: "haiku", label: "Haiku", reasoning: REASONING },
    { id: "claude-fable-5-1", label: "Fable", reasoning: REASONING },
  ],
  codex: [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", reasoning: REASONING },
    { id: "gpt-6-sol", label: "GPT-6-Sol", reasoning: REASONING },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", reasoning: REASONING },
  ],
  opencode: [
    { id: "opencode/claude-sonnet-5-5", label: "opencode/claude-sonnet-5-5", reasoning: [] },
    { id: "opencode/glm-5.3", label: "opencode/glm-5.3", reasoning: [] },
    { id: "opencode/gemini-3.8-flash", label: "opencode/gemini-3.8-flash", reasoning: [] },
    { id: "opencode/mimo-v2.6-flash", label: "opencode/mimo-v2.6-flash", reasoning: [] },
  ],
};

const HOST_ID = "fixture-host";

function handle(path: string): unknown {
  const url = new URL(path, "http://127.0.0.1");
  if (url.pathname === "/v1/agents") return { data: AGENTS, has_more: false };
  if (url.pathname === "/v1/hosts") {
    return {
      hosts: [{
        host_id: HOST_ID,
        configured_harnesses: Object.fromEntries(AGENTS.map((agent) => [agent.harness, true])),
      }],
    };
  }
  const options = url.pathname.match(/^\/v1\/hosts\/[^/]+\/harnesses\/([^/]+)\/model-options$/);
  if (options) {
    const harness = decodeURIComponent(options[1]).replace(/-native$/, "");
    return {
      models: (MODELS[harness] ?? []).map((model) => ({
        id: model.id,
        displayName: model.label,
        supportedReasoningEfforts: model.reasoning.map((reasoningEffort) => ({ reasoningEffort })),
      })),
    };
  }
  return undefined;
}

export function startOmnigentStub(port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const body = handle(req.url ?? "/");
    if (body === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("Pass a port");
  const stub = await startOmnigentStub(port);
  console.log(`omnigent stub listening on ${stub.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void stub.close().then(() => process.exit(0)));
  }
}
