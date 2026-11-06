import type { Item } from "./types.js";

export function selectedInboxItem(previous: Item | null, items: Item[], status: Item["status"]): Item | null {
  return previous ? items.find((item) => item.id === previous.id && item.status === status) ?? null : null;
}

export function visibleInboxItems(items: Item[], now: number): Item[] {
  return items.filter((item) => item.status !== "open" || item.snooze_until_ms === null || item.snooze_until_ms <= now);
}
