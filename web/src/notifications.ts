import type { Item } from "./types.js";

/** Notify on arrival and when a PR becomes ready, including after reopening. */
export function createNotificationTracker() {
  const notified = new Map<string, "open" | "ready">();
  return (event: { type: string; item?: Item }) => {
    if (event.type !== "item.created" && event.type !== "item.updated") return null;
    const { item } = event;
    if (!item) return null;
    if (item.status !== "open" || (item.kind !== "question" && item.kind !== "pr")) {
      notified.delete(item.id);
      return null;
    }
    const previous = notified.get(item.id);
    const state = item.kind === "pr" && item.ready === 1 ? "ready" : "open";
    notified.set(item.id, state);
    return !previous || (state === "ready" && previous !== "ready") ? item : null;
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
