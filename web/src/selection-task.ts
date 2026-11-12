// Turn a text selection into a task: select a passage (in the inbox, typically)
// and the app offers to open the Tasks page with the prompt already filled.
// Pure helpers so the URL contract is testable without a browser.

/** A stray word or two is a slip, not something worth dispatching. */
export const MIN_SELECTION_CHARS = 3;
/** Keep the deep link short; the prompt textarea is editable anyway. */
export const MAX_SELECTION_CHARS = 4000;

/** The selection, normalized into a prompt: trimmed, LF line endings, capped. */
export function promptFromSelection(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text.length <= MAX_SELECTION_CHARS) return text;
  return `${text.slice(0, MAX_SELECTION_CHARS).trimEnd()}…`;
}

/** Whether a selection is substantial enough to offer the "New task" action. */
export function isTaskSelection(raw: string | null | undefined): boolean {
  return promptFromSelection(raw).length >= MIN_SELECTION_CHARS;
}

/** Tasks-page route that carries a prefilled prompt: `#/tasks?prompt=…`. */
export function selectionTaskHash(prompt: string): string {
  return `#/tasks?${new URLSearchParams({ prompt: promptFromSelection(prompt) }).toString()}`;
}

/** Read a prefilled prompt out of a hash route; null for any other route. */
export function promptFromHash(hash: string): string | null {
  const route = hash.replace(/^#\/?/, "").replace(/^\//, "");
  const queryAt = route.indexOf("?");
  if (queryAt === -1) return null;
  if (route.slice(0, queryAt) !== "tasks") return null;
  const prompt = new URLSearchParams(route.slice(queryAt + 1)).get("prompt");
  const text = prompt ? promptFromSelection(prompt) : "";
  return text ? text : null;
}
