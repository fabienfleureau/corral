import { Db } from "../server/db.ts";
import type { Task } from "../server/types.ts";
import { pathToFileURL } from "node:url";

export function seedScreenshotData(db: Db): void {
  const rows: Pick<Task, "id" | "title" | "status" | "target" | "model" | "reasoning">[] = [
    { id: "sample-open", title: "Improve search results", status: "open", target: "codex", model: "gpt-5.4", reasoning: "high" },
    { id: "sample-running", title: "Add keyboard navigation", status: "dispatched", target: "claude", model: null, reasoning: null },
    { id: "sample-done", title: "Update project documentation", status: "done", target: "codex", model: null, reasoning: null },
  ];
  const now = Date.UTC(2025, 0, 15, 12);
  rows.forEach((row, index) => db.insertTask({
    ...row, prompt: row.title, repo_path: "/sample/example-project", target_state: "confirmed",
    base_branch: "main", branch: null, worktree_path: null, assignee: null, jira_key: null,
    jira_url: null, jira_parent_key: null, pr_url: null, pr_meta: null, terminal_address: null,
    exit_code: null, created_ms: now - index * 60000, updated_ms: now - index * 60000,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Pass a new fixture database path");
  const db = new Db(process.argv[2]);
  try { seedScreenshotData(db); } finally { db.close(); }
}
