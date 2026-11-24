// Retries and repo mismatches: a task archived or failed and recreated with the
// same label is linked with retry_of; the task form warns when a code prompt
// targets another registered repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { collectImprovementEvidence } from "../improvement-evidence.ts";
import { findRepeatOf, findRetryOf, RETRY_WINDOW_MS } from "../repeat.ts";
import { repoMismatch } from "../../web/src/repo-mismatch.ts";
import type { Task } from "../types.ts";

const NOW = 1_800_000_000_000;

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "old", title: "", prompt: "", kind: "code", repo_path: "/repos/corral",
    target: "claude", target_state: "suggested", base_branch: null, branch: null, worktree_path: null,
    assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null,
    status: "archived", terminal_address: null, exit_code: null, created_ms: NOW - 60_000, updated_ms: NOW - 60_000, ...over,
  };
}

test("findRetryOf: same label as a task archived or failed within 24 h, any repo or harness", () => {
  const fresh = makeTask({ id: "new", status: "open", repo_path: "/repos/crpg", target: "codex", prompt: "Les droplets manquent sur la carte" });
  const archived = makeTask({ id: "archived", title: "", prompt: "les droplets manquent sur la carte !" });
  assert.equal(findRetryOf(fresh, [archived], NOW), "archived", "repo and harness changed");
  const failedRun = makeTask({ id: "failed", status: "done", exit_code: 1, title: "Les droplets manquent sur la carte" });
  assert.equal(findRetryOf(fresh, [failedRun], NOW), "failed");
  assert.equal(findRetryOf(fresh, [makeTask({ id: "ok", status: "done", exit_code: 0, prompt: fresh.prompt })], NOW), null, "a successful run is a repeat, not a retry");
  assert.equal(findRetryOf(fresh, [makeTask({ id: "stale", prompt: fresh.prompt, updated_ms: NOW - RETRY_WINDOW_MS - 1 })], NOW), null, "older than 24 h");
  assert.equal(findRetryOf(fresh, [makeTask({ id: "other", prompt: "Les droplets manquent sur le menu" })], NOW), null, "different label");
  assert.equal(findRetryOf(fresh, [makeTask({ id: "open", status: "open", prompt: fresh.prompt })], NOW), null, "still open");
});

test("findRepeatOf: a failed run is not done work", () => {
  const fresh = makeTask({ id: "new", status: "open", title: "KPI text rendering broken again" });
  assert.equal(findRepeatOf(fresh, [makeTask({ id: "failed", status: "done", exit_code: 2, title: "KPI text rendering broken" })]), null);
});

test("api: a recreated task records retry_of, its history and the evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-retry-"));
  const db = new Db(join(dir, "test.db"));
  const now = Date.now();
  db.insertTask(makeTask({ id: "archived", title: "Les droplets manquent sur la carte", created_ms: now - 120_000, updated_ms: now - 68_000 }));
  const server = createHttpServer({ db, hub: { broadcast: () => undefined }, cfg: { token: "test", configDir: dir } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Task>);
  try {
    const retry = await post({ prompt: "Les droplets manquent sur la carte", repo_path: "/repos/crpg" });
    assert.equal(retry.retry_of, "archived");
    assert.equal(db.getTask(retry.id)?.retry_of, "archived");
    const created = db.listTaskEvents(retry.id).find((e) => e.kind === "created");
    assert.match(created?.message ?? "", /retry of "Les droplets manquent sur la carte", archived/);
    assert.equal((await post({ prompt: "Add keyboard navigation", repo_path: "/repos/crpg" })).retry_of, null);
    const evidence = collectImprovementEvidence(db);
    assert.deepEqual(evidence.data_quality.retries, [{ task_id: retry.id, retry_of: "archived" }]);
    assert.ok(evidence.tasks.find((t) => t.id === retry.id)?.flags.includes("retry"));
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const repos = [
  { path: "/repos/corral", name: "corral" },
  { path: "/repos/crpg", name: "crpg" },
  { path: "/repos/q-core", name: "q-core" },
];
const history = [
  { repo_path: "/repos/corral", title: "Inbox keyboard navigation", prompt: "" },
  { repo_path: "/repos/corral", title: "KPI artifact rendering", prompt: "" },
  { repo_path: "/repos/crpg", title: "Droplets spawn on the map", prompt: "" },
  { repo_path: "/repos/crpg", title: "Loot tables for droplets and chests", prompt: "" },
];

test("repoMismatch: a prompt naming another repo warns, naming the selected one does not", () => {
  assert.deepEqual(repoMismatch("Fix the deployment status mapping in q-core", "/repos/corral", repos, history), { path: "/repos/q-core", name: "q-core", reason: "named", terms: [] });
  assert.equal(repoMismatch("Port the corral inbox idea to q-core", "/repos/corral", repos, history), null, "the selected repo is named too");
  assert.equal(repoMismatch("Fix the crpgx build", "/repos/corral", repos, history), null, "a name inside a longer word");
});

test("repoMismatch: words only another repo's tasks use warn when the selected repo has none", () => {
  const hit = repoMismatch("Les droplets manquent sur la map", "/repos/corral", repos, history);
  assert.equal(hit?.name, "crpg");
  assert.equal(hit?.reason, "terms");
  assert.deepEqual(hit?.terms, ["droplet", "map"]);
  assert.equal(repoMismatch("Les droplets manquent sur la map", "/repos/crpg", repos, history), null, "right repo");
  assert.equal(repoMismatch("Droplets in the KPI artifact", "/repos/corral", repos, history), null, "the selected repo's words count too");
  assert.equal(repoMismatch("Droplets are broken", "/repos/corral", repos, history), null, "one word is not enough");
  assert.equal(repoMismatch("", "/repos/corral", repos, history), null);
});

test("repoMismatch: an archived task, often the wrong-repo attempt, does not count", () => {
  const withMistake = [...history, { repo_path: "/repos/corral", title: "Les droplets manquent sur la map", prompt: "", status: "archived" }];
  assert.equal(repoMismatch("Les droplets manquent sur la map", "/repos/corral", repos, withMistake)?.name, "crpg");
});

test("db: a retry candidate is dated by its archive, not by a later write", () => {
  const db = new Db(":memory:");
  try {
    db.insertTask(makeTask({ id: "late-touch", status: "open" }));
    db.updateTask("late-touch", { status: "archived" });
    db.raw.prepare("UPDATE task_events SET ts = ? WHERE task_id = ? AND kind = 'status'").run(Date.now() - 2 * RETRY_WINDOW_MS, "late-touch");
    // A cleanup pass writes the task long after the archive and moves updated_ms.
    db.updateTask("late-touch", { branch: null });
    assert.equal(db.listEndedTasksSince(Date.now() - RETRY_WINDOW_MS).length, 0);
  } finally { db.close(); }
});
