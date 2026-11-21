import { test } from "node:test";
import { strict as assert } from "node:assert";
import { OmnigentBackend } from "../omnigent.ts";
import { resolveExecutable } from "../exec.ts";
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
    writeFileSync(join(dir, "opencode"), "#!/bin/sh\nprintf 'provider/model-a\\nprovider/model-b\\nvendor/sub/provider/model-c\\n'\n", { mode: 0o755 });
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
      { id: "vendor/sub/provider/model-c", label: "vendor/sub/provider/model-c", reasoning: [] },
    ]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to local Antigravity models when the host has no catalog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-agy-models-"));
  const oldPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "agy"), "#!/bin/sh\nprintf 'gemini-4-neon-high\\tGemini 4 Neon (High)\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\nFetching available models...\\n'\n", { mode: 0o755 });
    process.env.PATH = dir;
    const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "host1", agents: {} });
    (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, path) => {
      if (path.startsWith("/v1/agents")) return { data: [{ id: "1", name: "antigravity-native-ui", harness: "antigravity-native" }] };
      if (path === "/v1/hosts") return { hosts: [{ host_id: "host1" }] };
      throw new Error("unsupported");
    };
    assert.deepEqual((await backend.harnesses())[0].models, [
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", reasoning: [] },
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", reasoning: [] },
    ]);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finds a CLI installed outside the server PATH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-cli-"));
  const oldPath = process.env.PATH;
  try {
    const bin = join(dir, "opencode");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // A GUI-launched server gets a bare PATH: user installs are unreachable.
    process.env.PATH = "/usr/bin:/bin";
    assert.equal(resolveExecutable("opencode"), null);
    assert.equal(resolveExecutable("opencode", [dir]), bin);
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});


test("session creation files the task group in an Omnigent project", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  const posts: { path: string; body: any }[] = [];
  let labels: unknown;
  let projectId: unknown;
  (backend as unknown as { request: (m: string, p: string, b?: any) => Promise<any> }).request = async (method, path, body) => {
    if (path.startsWith("/v1/agents")) return { data: [{ id: "a", name: "custom", harness: "codex-native" }] };
    if (method === "GET" && path === "/v1/projects") return { data: [{ id: "p1", name: "Other repo" }] };
    if (method === "POST" && path === "/v1/projects") { posts.push({ path, body }); return { id: "p2", name: body.name }; }
    if (method === "POST" && path === "/v1/sessions") { labels = body.labels; projectId = body.project_id; return { id: "s" }; }
    if (method === "GET") return { id: "s" };
    return {};
  };
  await backend.start({ taskId: "t", name: null, repoPath: "/repo", git: null, prompt: "go", harness: "codex", agent: "custom", model: null, reasoning: null, project: "My repo" });
  // The project is created once and the session is filed into it, not just
  // labelled: `project_id` is what omnigent's project features read.
  assert.deepEqual(posts, [{ path: "/v1/projects", body: { name: "My repo" } }]);
  assert.equal(projectId, "p2");
  assert.deepEqual(labels, { "corral.task": "t", "corral.harness": "codex", omni_project: "My repo" });
});

test("reuses an existing project and does not create a duplicate", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  const posts: string[] = [];
  const created: any[] = [];
  (backend as unknown as { request: (m: string, p: string, b?: any) => Promise<any> }).request = async (method, path, body) => {
    if (path.startsWith("/v1/agents")) return { data: [{ id: "a", name: "custom", harness: "codex-native" }] };
    if (method === "GET" && path === "/v1/projects") return { data: [{ id: "p1", name: "corral" }] };
    if (method === "POST" && path === "/v1/projects") { posts.push("projects"); return { id: "new" }; }
    if (method === "POST" && path === "/v1/sessions") { created.push(body); return { id: `s${created.length}` }; }
    if (method === "GET") return { id: "s" };
    return {};
  };
  const args = { taskId: "t", name: null, repoPath: "/repo", git: null, prompt: "go", harness: "codex", agent: "custom", model: null, reasoning: null, project: "corral" };
  await backend.start(args);
  await backend.start({ ...args, taskId: "t2" });
  assert.deepEqual(posts, []);
  assert.deepEqual(created.map((b) => b.project_id), ["p1", "p1"]);
  // A filed create must not let a project's git default force a worktree.
  assert.equal(created[0].git, null);
});

test("falls back to the legacy project label when the server has no projects API", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  let created: any;
  (backend as unknown as { request: (m: string, p: string, b?: any) => Promise<any> }).request = async (method, path, body) => {
    if (path.startsWith("/v1/agents")) return { data: [{ id: "a", name: "custom", harness: "codex-native" }] };
    if (path === "/v1/projects") throw new Error("omnigent GET /v1/projects -> 404: Not Found");
    if (method === "POST" && path === "/v1/sessions") { created = body; return { id: "s" }; }
    if (method === "GET") return { id: "s" };
    return {};
  };
  await backend.start({ taskId: "t", name: null, repoPath: "/repo", git: null, prompt: "go", harness: "codex", agent: "custom", model: null, reasoning: null, project: "My repo" });
  assert.equal("project_id" in created, false);
  assert.equal(created.labels.omni_project, "My repo");
});

test("retries without the project when the cached project was deleted", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  const attempts: any[] = [];
  let deleted = false;
  (backend as unknown as { request: (m: string, p: string, b?: any) => Promise<any> }).request = async (method, path, body) => {
    if (path.startsWith("/v1/agents")) return { data: [{ id: "a", name: "custom", harness: "codex-native" }] };
    if (method === "GET" && path === "/v1/projects") return { data: [{ id: "p1", name: "corral" }] };
    if (method === "POST" && path === "/v1/sessions") {
      attempts.push(body);
      if (body.project_id && deleted) throw new Error('omnigent POST /v1/sessions -> 404: {"error":{"message":"Project not found"}}');
      return { id: "s" };
    }
    if (method === "GET") return { id: "s" };
    return {};
  };
  const args = { taskId: "t", name: null, repoPath: "/repo", git: null, prompt: "go", harness: "codex", agent: "custom", model: null, reasoning: null, project: "corral" };
  await backend.start(args);
  deleted = true;
  await backend.start({ ...args, taskId: "t2" });
  assert.equal(attempts.length, 3);
  assert.equal(attempts[1].project_id, "p1");
  assert.equal("project_id" in attempts[2], false);
  assert.equal(attempts[2].labels.omni_project, "corral");
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

test("antigravity sessions launch with permission bypass; other harnesses keep their default", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  const created: any[] = [];
  (backend as unknown as { request: (m: string, p: string, b?: any) => Promise<any> }).request = async (method, path, body) => {
    if (path.startsWith("/v1/agents")) return { data: [
      { id: "ag", name: "corral-antigravity", harness: "antigravity-native" },
      { id: "cx", name: "corral-codex", harness: "codex-native" },
    ] };
    if (method === "POST" && path === "/v1/sessions") { created.push(body); return { id: "s" }; }
    if (method === "GET") return { id: "s" };
    return {};
  };
  const base = { taskId: null, name: null, repoPath: "/repo", git: null, prompt: "go", model: null, reasoning: null };
  await backend.start({ ...base, harness: "antigravity" });
  await backend.start({ ...base, harness: "codex" });
  // agy's request-review prompt would park an unattended task on an approval
  // card, so the launch args must be on the create body, not just the bundle.
  assert.deepEqual(created[0].terminal_launch_args, ["--dangerously-skip-permissions"]);
  assert.equal("terminal_launch_args" in created[1], false);
});

test("includes paginated user agents alongside built-in agents", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  (backend as unknown as { request: (m: string, p: string) => Promise<unknown> }).request = async (_m, path) => {
    const url = new URL(path, "http://x");
    if (url.pathname === "/v1/hosts") return { hosts: [] };
    if (url.searchParams.get("scope") !== "user") return { data: [{ id: "builtin", name: "codex-ui", harness: "codex-native" }] };
    if (!url.searchParams.has("after")) return { data: [], has_more: true, last_id: "cursor" };
    return { data: [{ id: "polie", name: "polie", harness: "codex" }], has_more: false };
  };
  assert.deepEqual((await backend.harnesses())[0].agents, [{ id: "builtin", name: "codex-ui" }, { id: "polie", name: "polie" }]);
});

test("only identifies a terminal startup error before any agent work", async () => {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  const prompt = { type: "message", role: "user", response_id: "r", content: [{ type: "input_text", text: "original request" }] };
  const failure = { type: "error", code: "native_terminal_start_failed", response_id: "r" };
  let data: unknown[] = [prompt, failure];
  (backend as unknown as { request: () => Promise<unknown> }).request = async () => ({ data });
  assert.equal(await backend.initialFailurePrompt("s"), "original request");
  data = [prompt, { ...failure, code: "other" }];
  assert.equal(await backend.initialFailurePrompt("s"), null);
  data = [prompt, { type: "function_call" }, failure];
  assert.equal(await backend.initialFailurePrompt("s"), null);
  data = [prompt, failure, prompt];
  assert.equal(await backend.initialFailurePrompt("s"), null);
});

type RequestCall = { method: string; path: string; body?: any };

function archiveBackend(reply: (call: RequestCall) => Promise<any> | any) {
  const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {} });
  const calls: RequestCall[] = [];
  (backend as unknown as { request: (m: string, p: string, b?: any) => Promise<any> }).request = async (method, path, body) => {
    const call = { method, path, body };
    calls.push(call);
    return reply(call);
  };
  return { backend, calls };
}

const filedSession = { id: "s1", project_id: "p1", labels: { "corral.task": "t", omni_project: "corral" } };
const filedProject = { data: [{ id: "p1", name: "corral", config: {} }] };
const noMembers = { data: [], has_more: false };

test("archiving detaches the session and deletes the emptied repository project", async () => {
  const { backend, calls } = archiveBackend(({ method, path }) => {
    if (method === "GET" && path === "/v1/sessions/s1") return filedSession;
    if (path === "/v1/projects") return filedProject;
    if (path.startsWith("/v1/sessions?")) return noMembers;
    return {};
  });
  await backend.archive("s1");
  assert.deepEqual(calls.find((c) => c.method === "PATCH" && c.path === "/v1/sessions/s1")?.body, {
    archived: true,
    project_id: "",
    labels: { omni_project: "" },
  });
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/v1/projects/p1"));
  assert.equal((backend as unknown as { projectIds: Map<string, string> }).projectIds.has("corral"), false);
});

test("a project with a live session is kept untouched", async () => {
  const { backend, calls } = archiveBackend(({ method, path }) => {
    if (method === "GET" && path === "/v1/sessions/s1") return filedSession;
    if (path === "/v1/projects") return filedProject;
    if (path.startsWith("/v1/sessions?") && path.includes("include_archived=false")) return { data: [{ id: "s2", archived: false }] };
    if (path.startsWith("/v1/sessions?")) return noMembers;
    return {};
  });
  await backend.archive("s1");
  assert.equal(calls.some((c) => c.method === "DELETE"), false);
  assert.equal(calls.some((c) => c.path === "/v1/sessions/s2"), false);
});

test("archived leftovers are unfiled before the project is deleted", async () => {
  let archivedReads = 0;
  const { backend, calls } = archiveBackend(({ method, path }) => {
    if (method === "GET" && path === "/v1/sessions/s1") return filedSession;
    if (path === "/v1/projects") return filedProject;
    if (path.startsWith("/v1/sessions?") && path.includes("include_archived=true")) {
      archivedReads += 1;
      return archivedReads === 1
        ? { data: [{ id: "old", archived: true, labels: { omni_project: "corral" } }], has_more: false }
        : noMembers;
    }
    if (path.startsWith("/v1/sessions?")) return noMembers;
    return {};
  });
  await backend.archive("s1");
  assert.deepEqual(calls.find((c) => c.method === "PATCH" && c.path === "/v1/sessions/old")?.body, {
    project_id: "",
    labels: { omni_project: "" },
  });
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/v1/projects/p1"));
});

test("a project Corral did not create is never deleted", async () => {
  for (const project of [
    { id: "p1", name: "corral", config: { model: "custom" } },
    { id: "p1", name: "renamed", config: {} },
  ]) {
    const { backend, calls } = archiveBackend(({ method, path }) => {
      if (method === "GET" && path === "/v1/sessions/s1") return filedSession;
      if (path === "/v1/projects") return { data: [project] };
      if (path.startsWith("/v1/sessions?")) return noMembers;
      return {};
    });
    await backend.archive("s1");
    assert.equal(calls.some((c) => c.method === "DELETE"), false, `project ${project.name}`);
  }
});

test("an older omnigent still archives when it rejects the unfile fields", async () => {
  const { backend, calls } = archiveBackend(({ method, path, body }) => {
    if (method === "GET" && path === "/v1/sessions/s1") return filedSession;
    if (path === "/v1/projects") throw new Error("404 Not Found");
    if (method === "PATCH" && path === "/v1/sessions/s1" && body.labels !== undefined) throw new Error("422 unrecognized field");
    return {};
  });
  await backend.archive("s1");
  assert.deepEqual(calls.filter((c) => c.method === "PATCH").map((c) => c.body), [
    { archived: true, labels: { omni_project: "" } },
    { archived: true },
  ]);
  assert.equal(calls.some((c) => c.method === "DELETE"), false);
});

test("a failed archive still fails the caller", async () => {
  const { backend } = archiveBackend(() => { throw new Error("unavailable"); });
  await assert.rejects(backend.archive("s1"), /unavailable/);
});
