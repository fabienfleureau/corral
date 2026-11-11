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
  api: { improvementStatus: () => Promise<unknown>; listTasks: () => Promise<unknown> };
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
