import type { Item, Task } from "./types.js";

/** The agent has the item: no human action needed while its run is in flight. */
export function isHandlingItem(item: Item): boolean {
  return (item.handling ?? 0) === 1;
}

export function selectedInboxItem(previous: Item | null, items: Item[], status: Item["status"] | "snoozed" | "in-progress"): Item | null {
  if (!previous) return null;
  const keep = (item: Item) =>
    status === "snoozed"
      ? item.status === "open"
      : status === "in-progress"
        ? item.status === "resolved" || isHandlingItem(item)
        : item.status === status && !isHandlingItem(item);
  return items.find((item) => item.id === previous.id && keep(item)) ?? null;
}

export function visibleInboxItems(items: Item[], now: number, view: "visible" | "snoozed" = "visible"): Item[] {
  if (view === "snoozed") return items.filter((item) => item.status === "open" && item.snooze_until_ms !== null && item.snooze_until_ms > now);
  return items.filter((item) => item.status !== "open" || item.snooze_until_ms === null || item.snooze_until_ms <= now);
}

/** Open items that ask the human for something — the agent is not on them. */
export function openInboxItems(items: Item[]): Item[] {
  return items.filter((item) => item.status === "open" && !isHandlingItem(item));
}

export function inProgressInboxItems(items: Item[], tasks: Task[]): Item[] {
  const active = new Set(tasks.filter((task) => task.status === "dispatched").map((task) => task.id));
  return items.filter(
    (item) =>
      item.status !== "archived" &&
      (isHandlingItem(item) || (item.status === "resolved" && item.task_id !== null && active.has(item.task_id))),
  );
}

export function inProgressInboxTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.status === "dispatched");
}
