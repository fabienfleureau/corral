import { test } from "node:test";
import { strict as assert } from "node:assert";
import { OmnigentBackend } from "../omnigent.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("falls back to local OpenCode models when the host catalog is unsupported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-models-"));
  const oldPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "opencode"), "#!/bin/sh\nprintf 'provider/model-a\\nprovider/model-b\\n'\n", { mode: 0o755 });
    process.env.PATH = dir;
    const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "host1", agents: {} });
    (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, path) => {
      if (path.startsWith("/v1/agents")) return { data: [{ id: "1", name: "opencode", harness: "opencode-native" }] };
      if (path === "/v1/hosts") return { hosts: [{ host_id: "host1" }] };
      throw new Error("unsupported");
    };
    assert.deepEqual((await backend.harnesses())[0].models, [
      { id: "provider/model-a", label: "provider/model-a", reasoning: [] },
      { id: "provider/model-b", label: "provider/model-b", reasoning: [] },
    ]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});


test("session creation files the task group in an Omnigent project", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  let labels: unknown;
  (backend as unknown as { request: (m: string, p: string, b?: any) => Promise<any> }).request = async (method, path, body) => {
    if (path.startsWith("/v1/agents")) return { data: [{ id: "a", name: "custom", harness: "codex-native" }] };
    if (method === "POST" && path === "/v1/sessions") { labels = body.labels; return { id: "s" }; }
    if (method === "GET") return { id: "s" };
    return {};
  };
  await backend.start({ taskId: "t", name: null, repoPath: "/repo", git: null, prompt: "go", harness: "codex", agent: "custom", model: null, reasoning: null, project: "My repo" });
  assert.deepEqual(labels, { "corral.task": "t", "corral.harness": "codex", omni_project: "My repo" });
});

test("session details expose the reported model and reasoning, not the model override", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async () => ({ id: "s", llm_model: "actual-model", model_override: "requested-model", reasoning_effort: "high" });
  const session = await backend.get("s");
  assert.equal(session?.model, "actual-model");
  assert.equal(session?.reasoning, "high");
});

test("rejects an agent belonging to a different harness before creating a session", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_method, path) => {
    if (path.startsWith("/v1/agents")) return { data: [{ id: "a", name: "opencode-ui", harness: "opencode-native" }] };
    throw new Error("session creation must not be reached");
  };
  await assert.rejects(backend.start({ taskId: "t", name: null, repoPath: "/repo", git: null, prompt: "go", harness: "codex", agent: "a", model: "terra", reasoning: null }), /opencode.*codex/);
});
