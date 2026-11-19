// Turn something picked elsewhere into a task: select a passage (in the inbox,
// typically) and the app offers to open the Tasks page with the prompt already
// filled; the Pull Requests page opens it on a review of one PR/MR.
// Pure helpers so the URL contract is testable without a browser. They stay
// dependency-free: Node loads this module from the tests, and the web build
// resolves imports differently.

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

/** Proposal a task was drafted from; the KPI follows its impact once it ships. */
export interface KpiTaskLink {
  id: string;
  proposal: string;
}

/** Tasks-page route for a KPI proposal: the prompt plus the KPI link. */
export function kpiTaskHash(prompt: string, link: KpiTaskLink): string {
  return `#/tasks?${new URLSearchParams({ prompt: promptFromSelection(prompt), kpi: link.id, proposal: link.proposal.slice(0, 160) }).toString()}`;
}

/** Tasks-page route that opens the form on a review of one PR/MR. */
export function reviewTaskHash(prUrl: string): string {
  return `#/tasks?${new URLSearchParams({ review: prUrl.trim() }).toString()}`;
}

/** What a Tasks deep link prefills: a prompt to work from, or a PR/MR to review. */
export interface TaskPrefill {
  text?: string;
  prUrl?: string;
  kpi?: KpiTaskLink;
}

/** The query of a `#/tasks?…` route, or null for any other route. */
function tasksQuery(hash: string): URLSearchParams | null {
  const route = hash.replace(/^#\/?/, "").replace(/^\//, "");
  const queryAt = route.indexOf("?");
  if (queryAt === -1) return null;
  if (route.slice(0, queryAt) !== "tasks") return null;
  return new URLSearchParams(route.slice(queryAt + 1));
}

/** Read a prefilled prompt out of a hash route; null for any other route. */
export function promptFromHash(hash: string): string | null {
  const prompt = tasksQuery(hash)?.get("prompt");
  const text = prompt ? promptFromSelection(prompt) : "";
  return text ? text : null;
}

/** Read a prefilled PR/MR URL out of a hash route; null when absent. The form
 *  checks the shape itself, so a bad link shows the same error as a typed one. */
export function reviewFromHash(hash: string): string | null {
  const url = tasksQuery(hash)?.get("review")?.trim() ?? "";
  return /^https?:\/\/\S+$/.test(url) ? url : null;
}

/** Tasks-page route that highlights an existing task: `#/tasks?task=<id>`. */
export function taskFocusHash(id: string): string {
  return `#/tasks?${new URLSearchParams({ task: id }).toString()}`;
}

/** Read a focused task id out of a hash route; null for any other route. */
export function taskFocusFromHash(hash: string): string | null {
  return tasksQuery(hash)?.get("task") || null;
}

/** Everything a Tasks deep link can prefill, or null when there is nothing. */
export function taskPrefillFromHash(hash: string): TaskPrefill | null {
  const text = promptFromHash(hash);
  const query = tasksQuery(hash);
  const kpi = query?.get("kpi"), proposal = query?.get("proposal")?.trim();
  if (text) return kpi && proposal ? { text, kpi: { id: kpi, proposal } } : { text };
  const prUrl = reviewFromHash(hash);
  return prUrl ? { prUrl } : null;
}
