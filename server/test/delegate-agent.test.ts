// The omnigent agent a delegate reviewer runs on: a bare harness agent that can
// spawn sub-agents, registered from a bundle whose name carries a content hash.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { gunzipSync } from "node:zlib";
import { OmnigentBackend, delegateBundle, makeTarGz } from "../omnigent.ts";

/** Entries of a tar.gz written by makeTarGz: path -> content. */
function untar(gz: Buffer): Record<string, string> {
  const tar = gunzipSync(gz);
  const out: Record<string, string> = {};
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(header.toString("ascii", 124, 136).replace(/\0.*$/s, ""), 8);
    out[name] = tar.toString("utf8", at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const child = (over: Partial<{ name: string; harness: string; prompt: string; harnessId: string }> = {}) =>
  ({ name: "ocr_codex", harness: "codex", prompt: "Review it.", harnessId: "codex-native", ...over });

test("makeTarGz keeps nested paths and exact content", () => {
  const files = { "config.yaml": "a: 1\n", "agents/ocr_codex/config.yaml": "b: 2\n".repeat(200) };
  const out = untar(makeTarGz(Object.entries(files).map(([name, content]) => ({ name, content }))));
  assert.deepEqual(out, files);
});

test("the delegate bundle is a spawn-capable bare harness agent with its children declared", () => {
  const { name, files } = delegateBundle("claude", "claude-native", [child(), child({ name: "ocr_claude", harness: "claude", harnessId: "claude-native" })]);
  assert.match(name, /^corral-claude-delegate-[0-9a-f]{8}$/);
  assert.deepEqual(files.map((f) => f.name), ["config.yaml", "agents/ocr_codex/config.yaml", "agents/ocr_claude/config.yaml"]);
  const parent = files[0].content;
  assert.match(parent, new RegExp(`^name: ${name}$`, "m"));
  assert.match(parent, /^spawn: true$/m);
  assert.match(parent, /^ {4}harness: claude-native$/m);
  assert.match(parent, /^tools:\n {2}agents:\n {4}- ocr_codex\n {4}- ocr_claude\n/m);
  // Same shape as corral-<harness>: no os_env, no sandbox, nothing that changes how the task runs.
  assert.doesNotMatch(parent, /os_env|sandbox|yolo|prompt:/);
  assert.match(files[1].content, /^ {4}harness: codex-native$/m);
  assert.match(files[2].content, /^ {4}harness: claude-native$/m);
  assert.doesNotMatch(files[1].content, /yolo|spawn/);
});

test("a delegate prompt survives YAML quoting verbatim", () => {
  const prompt = '  indented first line\nsecond: "quoted" \\ backslash $& $1 {base_branch}   ü\n\n# not a comment\n';
  const { files } = delegateBundle("claude", "claude-native", [child({ prompt })]);
  const line = files[1].content.split("\n").find((l) => l.startsWith("prompt: "));
  assert.ok(line);
  assert.equal(JSON.parse(line.slice("prompt: ".length)), prompt);
});

test("the bundle name changes with anything the bundle carries, and only then", () => {
  const base = delegateBundle("claude", "claude-native", [child()]).name;
  assert.equal(delegateBundle("claude", "claude-native", [child()]).name, base);
  assert.notEqual(delegateBundle("claude", "claude-native", [child({ prompt: "Review it twice." })]).name, base);
  assert.notEqual(delegateBundle("claude", "claude-native", [child({ harnessId: "codex" })]).name, base);
  assert.notEqual(delegateBundle("claude", "claude-sdk", [child()]).name, base);
  assert.notEqual(delegateBundle("claude", "claude-native", [child({ name: "ocr_other" })]).name, base);
});

test("a delegate name that is not a plain identifier is rejected", () => {
  for (const name of ["Bad", "1x", "has space", "a-b", "x\n  - evil", ""]) {
    assert.throws(() => delegateBundle("claude", "claude-native", [child({ name })]), /invalid delegate name/, name);
  }
});

type Req = (m: string, p: string, b?: unknown) => Promise<unknown>;

/** A backend whose omnigent is a stub: records session creates and bundle uploads. */
function stubbed(existingAgents: { id: string; name: string; harness: string }[]) {
  const backend = new OmnigentBackend({ baseUrl: "http://omnigent.test", token: "", hostId: "", agents: {} });
  const sessions: Record<string, unknown>[] = [];
  const uploads: Record<string, string>[] = [];
  (backend as unknown as { request: Req }).request = async (method, path, body) => {
    if (path.startsWith("/v1/agents")) return { data: existingAgents };
    if (method === "POST" && path === "/v1/sessions") { sessions.push(body as Record<string, unknown>); return { id: "s" }; }
    if (method === "GET") return { id: "s" };
    return {};
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: FormData }) => {
    const blob = init.body.get("bundle") as Blob;
    uploads.push(untar(Buffer.from(await blob.arrayBuffer())));
    return new Response(JSON.stringify({ id: `agent-${uploads.length}` }), { status: 200 });
  }) as typeof fetch;
  return { backend, sessions, uploads, restore: () => { globalThis.fetch = realFetch; } };
}

const REGISTRY = [
  { id: "c1", name: "claude-native-ui", harness: "claude-native" },
  { id: "x1", name: "codex-native-ui", harness: "codex-native" },
];
const START = { taskId: null, name: null, repoPath: "/repo", git: null, prompt: "go", harness: "claude", model: null, reasoning: null };
const DELEGATE = { name: "ocr_codex", harness: "codex", prompt: "Review it." };

test("start with delegates registers the delegate agent once and runs the session on it", async () => {
  const { backend, sessions, uploads, restore } = stubbed(REGISTRY);
  try {
    await backend.start({ ...START, delegates: [DELEGATE] });
    await backend.start({ ...START, taskId: "t2", delegates: [DELEGATE] });
    assert.equal(uploads.length, 1, "the second start reuses the registered agent");
    const bundle = uploads[0];
    assert.deepEqual(Object.keys(bundle), ["config.yaml", "agents/ocr_codex/config.yaml"]);
    assert.match(bundle["config.yaml"], /^spawn: true$/m);
    assert.match(bundle["agents/ocr_codex/config.yaml"], /^ {4}harness: codex-native$/m);
    assert.deepEqual(sessions.map((s) => s.agent_id), ["agent-1", "agent-1"]);
  } finally {
    restore();
  }
});

test("start with delegates reuses an agent already registered under the same hash name", async () => {
  const name = delegateBundle("claude", "claude-native", [{ ...DELEGATE, harnessId: "codex-native" }]).name;
  const { backend, sessions, uploads, restore } = stubbed([...REGISTRY, { id: "old", name, harness: "claude-native" }]);
  try {
    await backend.start({ ...START, delegates: [DELEGATE] });
    assert.equal(uploads.length, 0);
    assert.equal(sessions[0].agent_id, "old");
  } finally {
    restore();
  }
});

test("a changed delegate prompt registers a new agent instead of running the stale one", async () => {
  const stale = delegateBundle("claude", "claude-native", [{ ...DELEGATE, harnessId: "codex-native" }]).name;
  const { backend, sessions, uploads, restore } = stubbed([...REGISTRY, { id: "old", name: stale, harness: "claude-native" }]);
  try {
    await backend.start({ ...START, delegates: [{ ...DELEGATE, prompt: "Review it, carefully." }] });
    assert.equal(uploads.length, 1);
    assert.notEqual(sessions[0].agent_id, "old");
  } finally {
    restore();
  }
});

test("start refuses delegates combined with an explicit agent, before creating a session", async () => {
  const { backend, sessions, uploads, restore } = stubbed(REGISTRY);
  try {
    await assert.rejects(backend.start({ ...START, agent: "claude-native-ui", delegates: [DELEGATE] }), /explicit agent/);
    assert.equal(sessions.length + uploads.length, 0);
  } finally {
    restore();
  }
});

test("a session without delegates still runs on the plain corral-<harness> agent", async () => {
  const { backend, sessions, uploads, restore } = stubbed(REGISTRY);
  try {
    await backend.start(START);
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0], {
      "config.yaml": [
        "spec_version: 1",
        "name: corral-claude",
        "description: Corral bare-harness agent",
        "executor:",
        "  type: omnigent",
        "  config:",
        "    harness: claude-native",
        "",
      ].join("\n"),
    });
    assert.equal(sessions[0].agent_id, "agent-1");
  } finally {
    restore();
  }
});
