import type { Item } from "./types.js";

export function selectedInboxItem(previous: Item | null, items: Item[], status: Item["status"] | "snoozed"): Item | null {
  return previous ? items.find((item) => item.id === previous.id && item.status === (status === "snoozed" ? "open" : status)) ?? null : null;
}

export function visibleInboxItems(items: Item[], now: number, view: "visible" | "snoozed" = "visible"): Item[] {
  if (view === "snoozed") return items.filter((item) => item.status === "open" && item.snooze_until_ms !== null && item.snooze_until_ms > now);
  return items.filter((item) => item.status !== "open" || item.snooze_until_ms === null || item.snooze_until_ms <= now);
}
