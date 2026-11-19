/** Resolving an item replaces the detail pane with the next item. Keep its
 *  buttons inert briefly so a second click cannot act on that next item. */
export const INBOX_ACTION_COOLDOWN_MS = 800;

export function inboxActionsLocked(busy: boolean, unlockAt: number, now: number): boolean {
  return busy || now < unlockAt;
}
