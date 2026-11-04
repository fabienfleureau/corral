import type { Item } from "./types.js";

export function selectedInboxItem(previous: Item | null, items: Item[], status: Item["status"]): Item | null {
  return previous ? items.find((item) => item.id === previous.id && item.status === status) ?? null : null;
}
