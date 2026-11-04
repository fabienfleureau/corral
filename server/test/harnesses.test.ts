import { test } from "node:test";
import { strict as assert } from "node:assert";
import { OmnigentBackend } from "../omnigent.ts";

test("harness picker excludes unavailable native harnesses on the configured host", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "host1", agents: {} });
  (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, path) => {
    if (path.startsWith("/v1/agents")) return { data: [
      { id: "1", name: "codex", harness: "codex-native" },
      { id: "2", name: "opencode", harness: "opencode-native" },
      { id: "3", name: "other", harness: "other-native" },
    ] };
    return { hosts: [{ id: "host1", configured_harnesses: { "codex-native": true, "opencode-native": "version-too-low" } }] };
  };
  assert.deepEqual((await backend.harnesses()).map((h) => h.harness), ["codex", "other"]);
});

test("uses host_id to hide unavailable harnesses while retaining custom agents", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "host1", agents: {} });
  (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, path) => {
    if (path.startsWith("/v1/agents")) return { data: [
      { id: "custom", name: "my-agent", harness: "claude-sdk" },
      { id: "missing", name: "missing", harness: "cursor-native" },
    ] };
    return { hosts: [{ host_id: "host1", configured_harnesses: { "claude-sdk": true, "cursor-native": "binary-missing" } }] };
  };
  assert.deepEqual(await backend.harnesses(), [{ harness: "claude", agents: [{ id: "custom", name: "my-agent" }] }]);
});

test("exposes visible host models and their supported reasoning levels", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "host1", agents: {} });
  (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, path) => {
    if (path.startsWith("/v1/agents")) return { data: [{ id: "1", name: "codex", harness: "codex-native" }] };
    if (path === "/v1/hosts") return { hosts: [{ host_id: "host1" }] };
    assert.equal(path, "/v1/hosts/host1/harnesses/codex-native/model-options");
    return { models: [{ id: "a", displayName: "Model A", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }, { id: "hidden", hidden: true }] };
  };
  assert.deepEqual((await backend.harnesses())[0].models, [{ id: "a", label: "Model A", reasoning: ["high"] }]);
});
