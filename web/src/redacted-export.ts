// Markdown views of Corral evidence. Everything is assembled in the browser
// and passed through the shared redactor before it can be copied or saved:
// no export endpoint, no upload, no change to the local-only trust model.

import { redactMarkdown } from "../../shared/redacted-markdown.ts";
import { itemDisplayTitle } from "./inbox-title.ts";
import type { Item, Task, TaskEvent, TaskEventKind } from "./types.ts";

export const KIND_LABELS: Record<TaskEventKind, string> = {
  created: "created",
  updated: "updated",
  status: "status",
  prompt: "prompt",
  question: "question",
  jira: "jira",
  pr: "pr",
  session: "session",
};

/** Preferred order of the detail keys, so a prompt shows its text first. */
const DETAIL_ORDER = ["text", "from", "to", "field", "pr", "key", "session", "source", "chars", "error"];

export function detailRows(event: TaskEvent): [string, string][] {
  if (!event.data) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    return [];
  }
  // The message already carries the from → to of a field change.
  const hidden = new Set(["from", "to"]);
  const keys = Object.keys(parsed).filter((k) => !hidden.has(k) && parsed[k] !== null && parsed[k] !== "");
  keys.sort((a, b) => {
    const ai = DETAIL_ORDER.indexOf(a);
    const bi = DETAIL_ORDER.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? bi : 99);
  });
  return keys.map((k) => {
    const value = parsed[k];
    return [k, typeof value === "string" ? value : JSON.stringify(value)] as [string, string];
  });
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The history dialog as a flat document, in the same order as the UI. */
export function taskHistoryMarkdown(title: string, events: TaskEvent[]): string {
  const lines = [
    `# History: ${oneLine(title) || "Untitled task"}`,
    "",
    "_Corral export · local paths, credentials and shell transcripts removed._",
    "",
  ];
  for (const event of events) {
    const when = new Date(event.ts).toISOString();
    lines.push(`- **${when} · ${KIND_LABELS[event.kind]}** ${oneLine(event.message)}`);
    for (const [key, value] of detailRows(event)) {
      lines.push(`  - ${key.replace(/_/g, " ")}: ${String(value).replace(/\n/g, "\n    ")}`);
    }
  }
  if (events.length === 0) lines.push("_No history recorded._");
  return redactMarkdown(lines.join("\n"));
}

/** One inbox report, without the verbatim context drawer. */
export function inboxReportMarkdown(item: Pick<Item, "kind" | "status" | "title" | "summary" | "body" | "structured" | "created_ms" | "task_id">, task?: Task | null): string {
  const bodyParts: string[] = [];
  if (!item.structured && item.summary) bodyParts.push(item.summary);
  if (item.body && item.body !== item.summary) bodyParts.push(item.body);
  const body = bodyParts.join("\n\n") || "_No report body recorded._";

  const lines = [
    `# ${oneLine(itemDisplayTitle(item.title)) || "Inbox report"}`,
    "",
    `- Kind: ${item.kind}`,
    `- Status: ${item.status}`,
    `- Captured: ${new Date(item.created_ms).toISOString()}`,
    `- Source: ${item.structured ? "structured report" : "auto-captured"}`,
  ];
  if (task) {
    lines.push(`- Task: ${oneLine(task.title || task.prompt.split("\n")[0]) || "Untitled task"}`);
    if (task.jira_key) lines.push(`- Jira: ${task.jira_key}`);
    if (task.pr_url) lines.push(`- PR/MR: ${task.pr_url}`);
  }
  lines.push("", "## Report", "", body, "", "_Corral export · raw agent output, local paths, credentials and shell transcripts excluded._");
  return redactMarkdown(lines.join("\n"));
}
