import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { addRepo } from "../repos.ts";
import { favoritesFor, repoContext } from "../../web/src/favorite-context.ts";

test("a repo has no context until one is set", () => {
  const db = new Db(":memory:");
  try {
    const repo = addRepo(db, "/repos/a");
    assert.equal(db.getRepo(repo.id)!.context, null);
    db.updateRepo(repo.id, { context: "personal" });
    assert.equal(db.getRepo(repo.id)!.context, "personal");
  } finally {
    db.close();
  }
});

test("repo PATCH accepts a context or null and rejects other values", async () => {
  const db = new Db(":memory:");
  const repo = addRepo(db, "/repos/a", { jiraPrefix: "ABC" });
  const server = createHttpServer({ db, cfg: { token: "test" }, hub: { broadcast() {} } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/repos/${repo.id}`;
    const patch = (body: object) => fetch(url, { method: "PATCH", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const set = await patch({ context: "personal" });
    assert.equal(set.status, 200);
    assert.equal((await set.json() as { context: string }).context, "personal");
    assert.equal((await patch({ context: null })).status, 200);
    assert.equal(db.getRepo(repo.id)!.context, null);
    assert.equal((await patch({ context: "work" })).status, 400);
    // Unknown fields are ignored instead of reaching the SQL update.
    assert.equal((await patch({ path: "/elsewhere", source: "scan" })).status, 200);
    assert.deepEqual([db.getRepo(repo.id)!.path, db.getRepo(repo.id)!.jira_prefix], ["/repos/a", "ABC"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test("the task form shows the favorites of the repo's context", () => {
  const favorites = [{ name: "work", context: "professional" as const }, { name: "home", context: "personal" as const }];
  const repos = [{ path: "/pro", context: null }, { path: "/perso", context: "personal" as const }];
  assert.equal(repoContext(repos, "/pro"), "professional");
  assert.equal(repoContext(repos, "/perso"), "personal");
  assert.equal(repoContext(repos, ""), null);
  assert.equal(repoContext(repos, "/unregistered"), null);
  assert.deepEqual(favoritesFor(favorites, "personal").map((f) => f.name), ["home"]);
  assert.deepEqual(favoritesFor(favorites, "professional").map((f) => f.name), ["work"]);
  assert.deepEqual(favoritesFor(favorites, null).map((f) => f.name), ["work", "home"]);
});
