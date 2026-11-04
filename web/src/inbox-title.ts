import type { Item, SessionInfo } from "./types.js";

export function inboxTitle(item: Pick<Item, "source_ref" | "title">, sessions: Pick<SessionInfo, "address" | "name">[]): string {
  return sessions.find((session) => session.address === item.source_ref)?.name?.trim() || item.title;
}
