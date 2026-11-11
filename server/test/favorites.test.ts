import { test } from "node:test";
import { deepStrictEqual, equal, throws } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFavorites } from "../favorites.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { Db } from "../db.ts";

test("favorites retain all dispatch choices and reject malformed input", () => {
  const favorites = [{ name: "Review", harness: "codex", agent: "reviewer", model: "m", reasoning: "high", context: "personal" }];
  deepStrictEqual(parseFavorites(favorites), favorites);
  deepStrictEqual(parseFavorites([]), []);
  throws(() => parseFavorites([{ ...favorites[0], harness: "" }]));
  throws(() => parseFavorites([{ ...favorites[0], agent: 42 }]));
});

test("favorites without a context are professional and unknown contexts are rejected", () => {
  const legacy = { name: "Review", harness: "codex", agent: "", model: "", reasoning: "" };
  deepStrictEqual(parseFavorites([legacy]), [{ ...legacy, context: "professional" }]);
  throws(() => parseFavorites([{ ...legacy, context: "work" }]));
  throws(() => parseFavorites([{ ...legacy, context: null }]));
});

test("saving favorites keeps their context, and later settings saves do not drop it", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "corral-favorites-"));
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ token: "test" }) + "\n");
  const db = new Db(":memory:");
  const cfg = {
    favorites: [] as ReturnType<typeof parseFavorites>,
    port: 4787,
    host: "127.0.0.1",
    token: "test",
    configDir,
    agents: {},
    assistant: [""],
    jira: { baseUrl: "", email: "", token: "", jql: "" },
    omnigent: { baseUrl: "", token: "", hostId: "", agents: {} },
    usage: { prices: {} },
  };
  const server = createHttpServer({
    db,
    cfg,
    hub: { broadcast() {} },
    backend: { name: "test" },
    jira: { configured: false },
  } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/config`;
  const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
  const put = (body: object) => fetch(base, { method: "PUT", headers, body: JSON.stringify(body) });
  const read = async () => (await (await fetch(base, { headers })).json()) as { favorites: { name: string; context: string }[] };
  const storedContexts = () =>
    (JSON.parse(readFileSync(configPath, "utf8")) as { favorites: { name: string; context: string }[] }).favorites.map((f) => f.context);
  const favorites = [
    { name: "Side project", harness: "codex", agent: "", model: "", reasoning: "", context: "personal" },
    { name: "Legacy review", harness: "claude", agent: "", model: "", reasoning: "" },
  ];
  try {
    equal((await put({ favorites })).status, 200);
    deepStrictEqual((await read()).favorites, [
      { ...favorites[0], context: "personal" },
      { ...favorites[1], context: "professional" },
    ]);
    // Saving other settings rewrites config.json: favorites and their contexts survive.
    equal((await put({ jira: { jql: "labels = AGENTIC_WORKFLOW" } })).status, 200);
    deepStrictEqual((await read()).favorites.map((f) => f.context), ["personal", "professional"]);
    deepStrictEqual(storedContexts(), ["personal", "professional"]);
    // A stale client can still overwrite the list, but a context it omits reads back as professional.
    equal((await put({ favorites: [favorites[1]] })).status, 200);
    deepStrictEqual((await read()).favorites, [{ ...favorites[1], context: "professional" }]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
