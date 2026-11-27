// Pure state helpers for the Recents / Pinned quick-jump strip.
// Persisted per browser in localStorage by use-recents-pins.ts.

export type QuickJumpRef = { kind: "item" | "task"; id: string };

export const MAX_RECENTS = 6;
export const MAX_PINS = 6;

export function sameQuickJumpRef(a: QuickJumpRef, b: QuickJumpRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Parse a stored JSON array of QuickJumpRef entries, dropping invalid or duplicate items. */
export function parseStoredRefs(raw: string | null, max: number): QuickJumpRef[] {
  if (!raw || max <= 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: QuickJumpRef[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { kind?: unknown; id?: unknown };
    if ((candidate.kind !== "item" && candidate.kind !== "task") || typeof candidate.id !== "string") continue;
    const id = candidate.id.trim();
    if (!id) continue;
    const ref: QuickJumpRef = { kind: candidate.kind, id };
    if (result.some((existing) => sameQuickJumpRef(existing, ref))) continue;
    result.push(ref);
    if (result.length >= max) break;
  }
  return result;
}

/** Move `entry` to the front of `current` and cap at `max`. */
export function recordRecent(current: QuickJumpRef[], entry: QuickJumpRef, max = MAX_RECENTS): QuickJumpRef[] {
  if (max <= 0 || !entry.id.trim()) return [];
  return [entry, ...current.filter((item) => !sameQuickJumpRef(item, entry))].slice(0, max);
}

/** Toggle `entry` in `current` pins: remove if present, otherwise prepend and cap at `max`. */
export function togglePin(current: QuickJumpRef[], entry: QuickJumpRef, max = MAX_PINS): QuickJumpRef[] {
  if (current.some((item) => sameQuickJumpRef(item, entry))) {
    return current.filter((item) => !sameQuickJumpRef(item, entry));
  }
  if (max <= 0 || !entry.id.trim()) return current;
  return [entry, ...current].slice(0, max);
}

export function isPinned(pins: QuickJumpRef[], entry: QuickJumpRef): boolean {
  return pins.some((item) => sameQuickJumpRef(item, entry));
}

/** Filter pinned and recent entries to those that currently exist, without duplicating pinned entries in recents. */
export function visibleStripEntries(
  pins: QuickJumpRef[],
  recents: QuickJumpRef[],
  exists: (ref: QuickJumpRef) => boolean,
): { pinned: QuickJumpRef[]; recents: QuickJumpRef[] } {
  const pinned = pins.filter(exists);
  const filteredRecents = recents.filter((ref) => exists(ref) && !pinned.some((pin) => sameQuickJumpRef(pin, ref)));
  return { pinned, recents: filteredRecents };
}
