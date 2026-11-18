import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

// The web client is bundled so the test drives the exact fetch/parse code the
// browser runs — a non-JSON success body must not leak a JSON.parse message.
const bundle = await build({
  stdin: { contents: `export { api, ApiError } from "./web/src/api.ts";`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "browser",
  format: "cjs",
  write: false,
});
type ApiModule = {
  api: {
    improvementStatus: () => Promise<unknown>;
    listTasks: () => Promise<unknown>;
    listEpics: () => Promise<unknown>;
    getEpic: (id: string) => Promise<unknown>;
    importEpic: (key: string) => Promise<unknown>;
    orchestrateEpic: (id: string, request: string) => Promise<unknown>;
    createEpicRequest: (id: string, input: unknown) => Promise<unknown>;
    archiveTask: (task: { id: string; terminal_address: string | null }) => Promise<unknown>;
  };
  ApiError: new (status: number, message: string) => Error & { status: number };
};
const module = { exports: {} as ApiModule };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { api, ApiError } = module.exports;

const realFetch = globalThis.fetch;
function stubFetch(body: string, init: ResponseInit) {
  globalThis.fetch = (async () => new Response(body, init)) as typeof fetch;
}

test("a non-JSON success body surfaces as a clear API error", async () => {
  stubFetch("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  try {
    await assert.rejects(
      () => api.improvementStatus(),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 200);
        assert.match(err.message, /GET \/api\/improvement returned text\/html/);
        assert.match(err.message, /restart it and reload/);
        assert.doesNotMatch(err.message, /JSON\.parse|Unexpected token|Unexpected end of JSON/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an empty success body is reported as a non-JSON response", async () => {
  stubFetch("", { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(() => api.listTasks(), /GET \/api\/tasks returned application\/json instead of JSON/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a JSON success body still parses", async () => {
  stubFetch(JSON.stringify([{ id: "task-1" }]), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    assert.deepEqual(await api.listTasks(), [{ id: "task-1" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Before the epics stack, the server sent {epic, tasks, links} for a detail
// and `task_count` rows for the list. Both are valid JSON, but the page asks
// for `views` and `summary` and used to render nothing.
const staleDetail = JSON.stringify({ epic: { id: "e-1" }, tasks: [], links: [] });
const currentDetail = JSON.stringify({
  epic: { id: "e-1" }, tasks: [], links: [], views: [],
  summary: { total: 0, merged: 0, testable: 0, ready: 0, blocked: 0 },
});

for (const [name, call] of [
  ["getEpic", () => api.getEpic("e-1")],
  ["importEpic", () => api.importEpic("OPS-12")],
] as const) {
  test(`${name} reports an old server instead of returning a detail without views`, async () => {
    stubFetch(staleDetail, { status: 200, headers: { "Content-Type": "application/json" } });
    try {
      await assert.rejects(call, (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.match(err.message, /old epic response/);
        assert.match(err.message, /restart it and reload/);
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

test("listEpics reports an old server instead of returning rows without a summary", async () => {
  stubFetch(JSON.stringify([{ id: "e-1", task_count: 3 }]), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(() => api.listEpics(), /old epic response/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a current epic detail still parses", async () => {
  stubFetch(currentDetail, { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const detail = await api.getEpic("e-1") as { views: unknown[] };
    assert.deepEqual(detail.views, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("archiving a task always clears its session when it has one", async () => {
  const calls: { method: string; url: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? "GET", url });
    return new Response(JSON.stringify({ id: "task" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await api.archiveTask({ id: "task-1", terminal_address: "session-1" });
    await api.archiveTask({ id: "task-2", terminal_address: null });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, [
    { method: "POST", url: "/api/tasks/task-1/archive-session" },
    { method: "PATCH", url: "/api/tasks/task-2" },
  ]);
});

// The Epic form has two actions with different side effects. Both use the same
// text field, but they must call different routes.
test("planning and task creation hit different epic routes", async () => {
  const calls: { url: string; method: string; body: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? "GET", body: String(init.body) });
    return new Response(JSON.stringify({ proposal: "plan" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await api.orchestrateEpic("e-1", "review the design");
    await api.createEpicRequest("e-1", { request: "review the design", favorite_name: "", repo_path: "" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ["POST", "/api/epics/e-1/orchestrate"],
    ["POST", "/api/epics/e-1/requests"],
  ]);
  assert.match(calls[0].body, /review the design/);
  assert.match(calls[1].body, /favorite_name/);
});
