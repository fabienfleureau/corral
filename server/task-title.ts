// Short titles for tasks created without one. Omnigent names the session, but
// nothing wrote that name back, so untitled tasks showed an 80-char prompt
// prefix everywhere. A deterministic title is stored at once; the assistant
// command may then replace it with a better one.

import type { Db } from "./db.ts";
import type { Hub } from "./capture.ts";
import { DATA_NOT_INSTRUCTIONS } from "./dispatch.ts";
import { TITLE_OPENER } from "./assistant-prompts.ts";

export const TITLE_MAX = 60;

/** Cut at the last word boundary that fits, with an ellipsis when cut. */
function clamp(text: string, max = TITLE_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The first sentence of the prompt's first non-empty line, without Markdown
 *  markers, trimmed to about 60 characters on a word boundary. */
export function deterministicTitle(prompt: string): string {
  const line = prompt
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)+/, "").replace(/[*_`]/g, "").trim())
    .find(Boolean) ?? "";
  const sentence = line.split(/(?<=[.!?])\s+/)[0].replace(/[.!?:]+$/, "").replace(/\s+/g, " ").trim();
  return clamp(sentence);
}

/** The assistant prompt for a title. The task text is the human's (or a
 *  pasted ticket's): framed as data. */
export function taskTitlePrompt(prompt: string): string {
  return [
    `${TITLE_OPENER} Write a title for the task described below.`,
    `Reply with the title only: one line, at most ${TITLE_MAX} characters, imperative mood, no quotes, no trailing period.`,
    "",
    DATA_NOT_INSTRUCTIONS,
    "",
    "--- task description ---",
    prompt.slice(0, 4000),
  ].join("\n");
}

/** The assistant's reply as a title, or null when unusable. */
export function cleanTitle(reply: string): string | null {
  const line = reply.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const text = line.replace(/^(?:title:\s*)/i, "").replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").replace(/[.]+$/, "").replace(/\s+/g, " ").trim();
  return text ? clamp(text) : null;
}

export type TitleCompleter = (prompt: string) => Promise<string>;

/** Give an untitled task a title now (deterministic) and, when an assistant is
 *  available, a better one later. The later one only replaces the title the
 *  first step wrote, never a title the human set meanwhile. */
export function ensureTaskTitle(db: Db, hub: Hub, taskId: string, complete?: TitleCompleter | null): Promise<void> {
  const task = db.getTask(taskId);
  if (!task || task.title.trim() || !task.prompt.trim()) return Promise.resolve();
  const fallback = deterministicTitle(task.prompt);
  if (!fallback) return Promise.resolve();
  db.updateTask(taskId, { title: fallback }, false);
  hub.broadcast("task.updated", db.getTask(taskId));
  if (!complete) return Promise.resolve();
  return complete(taskTitlePrompt(task.prompt))
    .then((reply) => {
      const title = cleanTitle(reply);
      const current = db.getTask(taskId);
      if (!title || !current || current.title !== fallback || title === fallback) return;
      db.updateTask(taskId, { title }, false);
      hub.broadcast("task.updated", db.getTask(taskId));
    })
    .catch(() => undefined);
}
