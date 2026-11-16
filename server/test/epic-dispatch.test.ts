// An epic task is dispatched with the precondition check; other tasks are not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Db } from "../db.ts";
import { dispatchTask } from "../dispatch.ts";
import type { Config } from "../config.ts";
import type { WorkerBackend, WorkerStart, WorkerSession } from "../worker.ts";
import type { Task } from "../types.ts";

function run(over: Partial<Task>, check: (prompt: string) => void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "corral-epic-d-"));
    const db = new Db(join(dir, "t.db"));
    execFileSync("git", ["init", "-q", dir]);
    const started: WorkerStart[] = [];
    const backend = {
      name: "fake",
      async start(s: WorkerStart): Promise<WorkerSession> {
        started.push(s);
        return { address: "s1", task_id: s.taskId, name: s.name, harness: s.harness, status: "working", blocked_kind: null, state: "live", turn: 1, cwd: s.repoPath, created_ms: Date.now(), exit_code: null, parent: null };
      },
      list: async () => [], get: async () => null, read: async () => "", send: async () => undefined, resolveElicitation: async () => undefined,
      kill: async () => undefined, history: async () => "", tree: async () => [], onEvent: () => ({ stop: () => undefined }),
    } as WorkerBackend;
    const now = Date.now();
    const task: Task = {
      id: "t1", title: "E-2 Use the lib", prompt: "Use lib X.\n\nPréconditions: lib X 2.0 is published", kind: "code", repo_path: dir, target: "codex", target_state: "suggested",
      base_branch: null, branch: null, worktree_path: null, assignee: null, jira_key: "E-2", jira_url: "https://j/browse/E-2", jira_parent_key: null, pr_url: null,
      pr_meta: null, status: "open", terminal_address: null, exit_code: null, created_ms: now, updated_ms: now, ...over,
    };
    db.insertTask(task);
    try {
      await dispatchTask(db, { configDir: dir, host: "localhost", port: 4787, token: "tok" } as Config, backend, task, "codex", { useWorktree: false });
      check(started[0].prompt);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("epic task: the precondition check follows the ticket text and comes before the conventions", run({ epic_id: "e1" }, (prompt) => {
  assert.match(prompt, /Preconditions of this epic task/);
  assert.ok(prompt.indexOf("lib X 2.0 is published") < prompt.indexOf("Preconditions of this epic task"));
  assert.ok(prompt.indexOf("Preconditions of this epic task") < prompt.indexOf("\n---\n"));
}));

test("a task outside an epic gets no precondition check", run({}, (prompt) => {
  assert.doesNotMatch(prompt, /Preconditions of this epic task/);
}));
