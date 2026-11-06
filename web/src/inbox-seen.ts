import type { Item } from "./types.js";

export function unseenInboxItems(items: Item[], seen: string[]): boolean {
  const ids = new Set(seen);
  return items.some((item) => !ids.has(item.id));
}

export function rememberInboxItems(seen: string[], items: Item[]): string[] {
  return [...new Set([...seen, ...items.map((item) => item.id)])];
}
