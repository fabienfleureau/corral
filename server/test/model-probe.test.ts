import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { LocalModelProbe } from "../model-probe.ts";
import { OmnigentBackend } from "../omnigent.ts";

/** A local model server stand-in; `reply` may never answer (timeout case). */
async function serve(reply: (res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((_req, res) => reply(res));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

test("an answering local server is up and lists its models", async () => {
  const server = await serve((res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "ornith-1.5-35b-a3b" }, { id: "" }, {}] }));
  });
  try {
    const probe = new LocalModelProbe();
    assert.deepEqual(await probe.availability(server.url), { status: "up", models: ["ornith-1.5-35b-a3b"] });
  } finally {
    await server.close();
  }
});

test("a refused connection is down", async () => {
  const server = await serve((res) => res.end("{}"));
  const url = server.url;
  await server.close();
  const probe = new LocalModelProbe();
  assert.deepEqual(await probe.availability(url), { status: "down", models: [] });
});

test("a server that never answers is unknown, not down", async () => {
  const server = await serve(() => undefined);
  try {
    const probe = new LocalModelProbe({ timeoutMs: 100 });
    assert.deepEqual(await probe.availability(server.url), { status: "unknown", models: [] });
  } finally {
    await server.close();
  }
});

test("an error status is down", async () => {
  const server = await serve((res) => {
    res.writeHead(503);
    res.end("unavailable");
  });
  try {
    const probe = new LocalModelProbe();
    assert.deepEqual(await probe.availability(server.url), { status: "down", models: [] });
  } finally {
    await server.close();
  }
});

test("results are cached for 30 s per base URL", async () => {
  let calls = 0;
  const server = await serve((res) => {
    calls += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "ornith-1.5-35b-a3b" }] }));
  });
  try {
    let now = 1_000_000;
    const probe = new LocalModelProbe({ clock: () => now });
    await probe.availability(server.url);
    await probe.availability(server.url);
    assert.equal(calls, 1);
    now += 30_001;
    await probe.availability(server.url);
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test("the worker backend probes only configured providers", async () => {
  const server = await serve((res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "ornith-1.5-35b-a3b" }] }));
  });
  try {
    const backend = new OmnigentBackend({ baseUrl: "http://x", token: "", hostId: "", agents: {}, localProviders: { "ornith-local": server.url } });
    assert.deepEqual(await backend.providerModels("ornith-local"), { status: "up", models: ["ornith-1.5-35b-a3b"] });
    assert.deepEqual(await backend.providerModels("some-other-local"), { status: "unknown", models: [] });
  } finally {
    await server.close();
  }
});
