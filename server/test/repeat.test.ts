// Probable repeats: a new task whose label nearly matches a done task in the
// same repo is tagged with repeat_of, shown in its history and counted in the
// improvement evidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "../db.ts";
import { createHttpServer, type AppState } from "../api.ts";
import { collectImprovementEvidence } from "../improvement-evidence.ts";
import { findRepeatOf, labelSimilarity, labelTokens } from "../repeat.ts";
import type { Task } from "../types.ts";

function makeTask(over: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: "done-1", title: "", prompt: "", kind: "code", repo_path: "/repos/corral",
    target: "claude", target_state: "suggested", base_branch: null, branch: null, worktree_path: null,
    assignee: null, jira_key: null, jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null,
    status: "done", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now, ...over,
  };
}

test("labelTokens: lowercase, no punctuation, accents, stop words, Jira keys or plural s", () => {
  assert.deepEqual([...labelTokens("fix(pr): The 'Ready for review' item stays after merge!")].sort(), ["item", "merge", "pr", "ready", "review", "stay"]);
  assert.deepEqual([...labelTokens("EX-12 Les droplets manquent dans la carte")].sort(), ["carte", "droplet", "manquent"]);
});

test("labelSimilarity: near-identical labels match, unrelated or too short ones do not", () => {
  assert.ok(labelSimilarity("Ready for review stays after merge", "fix: ready-for-review item stays after the PR merge") >= 0.6);
  assert.ok(labelSimilarity("KPI text rendering broken", "Fix KPI text rendering") >= 0.6);
  assert.ok(labelSimilarity("Epic import creates tasks", "Add keyboard navigation to the inbox") < 0.6);
  assert.equal(labelSimilarity("fix tests", "fix tests"), 0, "under three tokens never matches");
});

test("findRepeatOf: same repo, done, comparable kind; matches the done task's title or prompt", () => {
  const done = [
    makeTask({ id: "by-title", title: "Ready for review stays after merge", prompt: "something else entirely" }),
    makeTask({ id: "by-prompt", title: "", prompt: "KPI text rendering is broken\n\nDetails" }),
    makeTask({ id: "other-repo", title: "Epic import creates tasks twice", repo_path: "/repos/crpg" }),
    makeTask({ id: "still-open", title: "Usage chart misses the opencode quotas", status: "open" }),
    makeTask({ id: "a-review", title: "Sidebar quota colors wrong tiers", kind: "review" }),
  ];
  const fresh = (over: Partial<Task>) => makeTask({ id: "new", status: "open", ...over });
  assert.equal(findRepeatOf(fresh({ prompt: "The ready for review item stays after merge again" }), done), "by-title");
  assert.equal(findRepeatOf(fresh({ title: "Fix KPI text rendering" }), done), "by-prompt");
  assert.equal(findRepeatOf(fresh({ title: "Epic import creates tasks twice" }), done), null, "other repo");
  assert.equal(findRepeatOf(fresh({ title: "Usage chart misses the opencode quotas" }), done), null, "not done");
  assert.equal(findRepeatOf(fresh({ title: "Sidebar quota colors wrong tiers" }), done), null, "review task");
  assert.equal(findRepeatOf(fresh({ kind: "review", title: "Ready for review stays after merge" }), done), null, "new review task");
});

test("api: a new task repeating a done one gets repeat_of, a history note and evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corral-repeat-"));
  const db = new Db(join(dir, "test.db"));
  db.insertTask(makeTask({ id: "done-1", title: "Ready for review stays after merge" }));
  const server = createHttpServer({ db, hub: { broadcast: () => undefined }, cfg: { token: "test", configDir: dir } } as unknown as AppState);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Task>);
  try {
    const repeat = await post({ prompt: "Ready for review still stays after merge", repo_path: "/repos/corral" });
    assert.equal(repeat.repeat_of, "done-1");
    assert.equal(db.getTask(repeat.id)?.repeat_of, "done-1");
    const created = db.listTaskEvents(repeat.id).find((e) => e.kind === "created");
    assert.match(created?.message ?? "", /probable repeat of "Ready for review stays after merge"/);

    const unrelated = await post({ prompt: "Add keyboard navigation to the inbox", repo_path: "/repos/corral" });
    assert.equal(unrelated.repeat_of, null);
    const elsewhere = await post({ prompt: "Ready for review still stays after merge", repo_path: "/repos/crpg" });
    assert.equal(elsewhere.repeat_of, null);

    const evidence = collectImprovementEvidence(db);
    assert.deepEqual(evidence.data_quality.probable_repeats, [{ task_id: repeat.id, repeat_of: "done-1" }]);
    assert.ok(evidence.tasks.find((t) => t.id === repeat.id)?.flags.includes("probable_repeat"));
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
