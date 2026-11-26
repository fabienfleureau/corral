// The two exports the UI offers: one inbox report and one task history. They
// must stay byte-identical for copy and download, and lose local evidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxReportMarkdown, taskHistoryMarkdown } from "../../web/src/redacted-export.ts";
import type { Item, Task, TaskEvent } from "../../web/src/types.ts";

const TS = Date.UTC(2025, 0, 2, 9, 12);

function item(over: Partial<Item> = {}): Item {
  return {
    id: "item-1", kind: "question", status: "open", title: "Question about widget sizes",
    summary: "", body: "**Evidence** holds.", context: "", options: null, elicitation: null,
    source_ref: null, task_id: "task-1", structured: 1, ready: 0, handling: 0,
    created_ms: TS, updated_ms: TS, resolved_ms: null, snooze_until_ms: null, ...over,
  };
}

function task(): Task {
  return {
    id: "task-1", title: "Spec widgets", prompt: "Spec widgets", kind: "spec", repo_path: "/sample/repo",
    target: "claude", target_state: "confirmed", agent: null, model: null, reasoning: null,
    session_model: null, session_reasoning: null, base_branch: null, branch: null, worktree_path: null,
    assignee: null, jira_key: "EX-1", jira_url: null, jira_parent_key: null,
    pr_url: "https://example.com/pull/12", review: null, status: "done",
    terminal_address: null, exit_code: null, created_ms: TS, updated_ms: TS,
  };
}

test("history export keeps the event order and removes paths and credentials from details", () => {
  const events = [
    {
      id: 1, task_id: "task-1", ts: TS, kind: "prompt", message: "Initial prompt sent to claude",
      data: JSON.stringify({ source: "dispatch", chars: 42, text: "Read /Users/fabien/workspace/perso/corral-worktrees/corral-x/server/api.ts\nAuthorization: Bearer abcdef1234567890" }),
    },
    {
      id: 2, task_id: "task-1", ts: TS + 1000, kind: "session", message: "Worktree: /Users/fabien/repo-worktrees/feat-x", data: null,
    },
  ] as TaskEvent[];

  const out = taskHistoryMarkdown("Spec widgets", events);
  assert.match(out, /^# History: Spec widgets/);
  assert.match(out, /2025-01-02T09:12:00\.000Z · prompt\*\* Initial prompt sent to claude/);
  assert.match(out, /2025-01-02T09:12:01\.000Z · session\*\*/);
  assert.match(out, /text: Read \[local path\]/);
  assert.match(out, /Authorization: \[redacted\]/);
  assert.doesNotMatch(out, /fabien|corral-x|repo-worktrees|abcdef1234567890/);
  assert.ok(out.indexOf("· prompt") < out.indexOf("· session"));
});

test("history export says so when there is nothing to share", () => {
  assert.match(taskHistoryMarkdown("Empty task", []), /_No history recorded\._/);
});

test("inbox export drops raw context and shell output but keeps the report and task links", () => {
  const out = inboxReportMarkdown(item({
    title: "PR ready for review: Widget sizes",
    summary: "See /Users/fabien/notes.md",
    body: "Report:\n\n```console\n$ ls /Users/fabien/repo\ntoken: abcdef1234567890\n```\n\nConclusion: safe to paste.",
    context: "VERBATIM LOG $ export SECRET=abcdef1234567890",
    structured: 0,
  }), task());

  assert.match(out, /^# Widget sizes/);
  assert.doesNotMatch(out, /PR ready for review:/);
  assert.match(out, /- Kind: question/);
  assert.match(out, /- Jira: EX-1/);
  assert.match(out, /- PR\/MR: https:\/\/example\.com\/pull\/12/);
  assert.match(out, /- Task: Spec widgets/);
  assert.match(out, /## Report/);
  assert.match(out, /Conclusion: safe to paste\./);
  assert.match(out, /\[shell transcript omitted\]/);
  assert.doesNotMatch(out, /VERBATIM LOG|SECRET=|notes\.md|abcdef1234567890/);
});

test("a structured report does not repeat its status summary as the body", () => {
  const out = inboxReportMarkdown(item({ summary: "ready for review", body: "**Thread**: needs a test." }), null);
  assert.equal(out.match(/ready for review/g), null);
  assert.match(out, /\*\*Thread\*\*: needs a test\./);
  assert.doesNotMatch(out, /- Task:/);
});
