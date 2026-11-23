// A pasted PR/MR URL picks a registered repo: git remotes first, then a unique
// project-name match. Tested purely, plus the HTTP seam the task form calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { gitRemoteUrls } from "../repos.ts";
import { matchRepoForPull, pullProject, type RepoCandidate } from "../repo-match.ts";
import { createHttpServer, type AppState } from "../api.ts";

const GH = "https://github.com/acme/frontend/pull/42";
const GL = "https://gitlab.example.com/acme/team/backend/-/merge_requests/12";

function repo(path: string, name: string, remotes: string[] = []): RepoCandidate {
  return { path, name, remotes };
}

test("the project part of GitHub and GitLab URLs is extracted", () => {
  assert.deepEqual(pullProject(GH), { host: "github.com", path: "acme/frontend", name: "frontend" });
  assert.deepEqual(pullProject(GL), { host: "gitlab.example.com", path: "acme/team/backend", name: "backend" });
  assert.deepEqual(pullProject("https://github.com/acme/frontend/pull/42/"), { host: "github.com", path: "acme/frontend", name: "frontend" });
  // The form accepts bare URLs only; keep the matcher to the same shape.
  assert.equal(pullProject(`${GL}?tab=notes`), null);
  assert.equal(pullProject("https://example.com/not-a-pr"), null);
  assert.equal(pullProject("github.com/acme/frontend/pull/42"), null);
});

test("a git remote picks the repo even when the folder has another name", () => {
  const repos = [
    repo("/work/app", "app", ["git@github.com:acme/frontend.git"]),
    repo("/work/backend", "backend", ["https://gitlab.example.com/acme/team/backend.git"]),
  ];
  assert.deepEqual(matchRepoForPull(GH, repos), { path: "/work/app", name: "app", via: "remote" });
  assert.deepEqual(matchRepoForPull(GL, repos), { path: "/work/backend", name: "backend", via: "remote" });
});

test("a remote on another host does not count as a match", () => {
  const repos = [repo("/work/app", "app", ["git@github.com:elsewhere/frontend.git"])];
  assert.equal(matchRepoForPull(GH, repos), null);
});

test("a unique project name picks the repo when no remote matches", () => {
  const repos = [repo("/work/one", "other"), repo("/work/two", "frontend")];
  assert.deepEqual(matchRepoForPull(GH, repos), { path: "/work/two", name: "frontend", via: "name" });
  assert.deepEqual(matchRepoForPull(GL, [repo("/work/backend", "renamed")]), { path: "/work/backend", name: "renamed", via: "name" });
});

test("ambiguous or absent matches are left to the human", () => {
  assert.equal(matchRepoForPull(GH, [repo("/a/frontend", "one"), repo("/b/frontend", "two")]), null);
  assert.equal(matchRepoForPull(GL, []), null);
  assert.equal(matchRepoForPull("https://example.com/x", [repo("/a/frontend", "frontend")]), null);
});

test("GET /api/repos/match reads local remotes and reports no match as null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-repo-match-"));
  const db = new Db(join(dir, "test.db"));
  const work = join(dir, "checkout");
  execFileSync("git", ["init", "-q", work]);
  execFileSync("git", ["-C", work, "remote", "add", "origin", "git@github.com:acme/frontend.git"]);
  db.insertRepo({ id: "r1", name: "local-checkout", path: work, jira_prefix: null, context: null, source: "manual", created_ms: Date.now() });
  const server = createHttpServer({ db, cfg: { token: "test", configDir: dir }, hub: { broadcast: () => undefined } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const call = (url: string) => fetch(`http://127.0.0.1:${port}/api/repos/match?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: "Bearer test" },
  }).then((res) => res.json() as Promise<{ repo_path: string | null; repo_name: string | null; via: string | null }>);
  try {
    assert.deepEqual(await call(GH), { repo_path: work, repo_name: "local-checkout", via: "remote" });
    assert.deepEqual(await call("https://github.com/acme/unknown/pull/1"), { repo_path: null, repo_name: null, via: null });
    assert.deepEqual(gitRemoteUrls(work), ["git@github.com:acme/frontend.git"]);
    assert.deepEqual(gitRemoteUrls(dir), []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
