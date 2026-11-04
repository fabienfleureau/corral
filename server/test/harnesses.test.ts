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
