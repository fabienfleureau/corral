import type { Item } from "./types.js";

/** Notify once per actionable period, including items reopened by the server. */
export function createNotificationTracker() {
  const notified = new Set<string>();
  return (event: { type: string; item?: Item }) => {
    if (event.type !== "item.created" && event.type !== "item.updated") return null;
    const { item } = event;
    if (!item) return null;
    const actionable = item.status === "open" && (item.kind === "question" || (item.kind === "pr" && item.ready === 1));
    if (!actionable) {
      notified.delete(item.id);
      return null;
    }
    if (notified.has(item.id)) return null;
    notified.add(item.id);
    return item;
  };
}

export function sendDesktopNotification(title: string, body: string): boolean {
  const NotificationApi = (globalThis as unknown as { Notification?: { permission: string; new(title: string, options: { body: string }): unknown } }).Notification;
  if (!NotificationApi || NotificationApi.permission !== "granted") return false;
  try {
    new NotificationApi(title, { body });
    return true;
  } catch {
    return false;
  }
}
