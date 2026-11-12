import type { Item, SessionInfo } from "./types.js";

// Corral composes a PR item title as "PR <gate status>: <pr title>" so API
// consumers see the gate in one string. The inbox row and its detail header
// already render that status as a badge, so the title drops it here instead of
// repeating it. Terminal states stay: "PR merged: …" has no badge to carry the
// outcome.
const GATE_PREFIX = /^PR (?:ready for review|ready to merge|needs work):\s*/;

/** The item title as the inbox shows it — without the status the badge carries. */
export function itemDisplayTitle(title: string): string {
  return title.replace(GATE_PREFIX, "");
}

export function inboxTitle(item: Pick<Item, "source_ref" | "title">, sessions: Pick<SessionInfo, "address" | "name">[]): string {
  return itemDisplayTitle(sessions.find((session) => session.address === item.source_ref)?.name?.trim() || item.title);
}
