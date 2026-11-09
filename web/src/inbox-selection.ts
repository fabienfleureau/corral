import type { Item, Task } from "./types.js";

export function selectedInboxItem(previous: Item | null, items: Item[], status: Item["status"] | "snoozed" | "in-progress"): Item | null {
  return previous ? items.find((item) => item.id === previous.id && item.status === (status === "snoozed" ? "open" : status === "in-progress" ? "resolved" : status)) ?? null : null;
}

export function visibleInboxItems(items: Item[], now: number, view: "visible" | "snoozed" = "visible"): Item[] {
  if (view === "snoozed") return items.filter((item) => item.status === "open" && item.snooze_until_ms !== null && item.snooze_until_ms > now);
  return items.filter((item) => item.status !== "open" || item.snooze_until_ms === null || item.snooze_until_ms <= now);
}

export function inProgressInboxItems(items: Item[], tasks: Task[]): Item[] {
  const active = new Set(tasks.filter((task) => task.status === "dispatched").map((task) => task.id));
  return items.filter((item) => item.status === "resolved" && item.task_id !== null && active.has(item.task_id));
}
