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

export function sendDesktopNotification(title: string, body: string, onError?: () => void): boolean {
  const NotificationApi = (globalThis as unknown as { Notification?: { permission: string; new(title: string, options: { body: string }): { onerror: (() => void) | null } } }).Notification;
  if (!NotificationApi || NotificationApi.permission !== "granted") return false;
  try {
    const notification = new NotificationApi(title, { body });
    if (onError) notification.onerror = onError;
    return true;
  } catch {
    return false;
  }
}
