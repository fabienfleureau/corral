// Browser-local persistence for the Recents / Pinned quick-jump strip.

import { useCallback, useState } from "react";
import {
  isPinned as hasPin,
  MAX_PINS,
  MAX_RECENTS,
  parseStoredRefs,
  recordRecent as prependRecent,
  togglePin as togglePinEntry,
  type QuickJumpRef,
} from "./recents-pins";

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: QuickJumpRef[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* Storage may be unavailable (private window, blocked site data). */ }
}

export function useRecentsPins(recentsKey: string, pinsKey: string) {
  const [recents, setRecents] = useState<QuickJumpRef[]>(() => parseStoredRefs(readStorage(recentsKey), MAX_RECENTS));
  const [pins, setPins] = useState<QuickJumpRef[]>(() => parseStoredRefs(readStorage(pinsKey), MAX_PINS));

  const recordRecent = useCallback((entry: QuickJumpRef) => {
    setRecents((prev) => {
      const next = prependRecent(prev, entry, MAX_RECENTS);
      writeStorage(recentsKey, next);
      return next;
    });
  }, [recentsKey]);

  const togglePin = useCallback((entry: QuickJumpRef) => {
    setPins((prev) => {
      const next = togglePinEntry(prev, entry, MAX_PINS);
      writeStorage(pinsKey, next);
      return next;
    });
  }, [pinsKey]);

  const isPinned = useCallback((entry: QuickJumpRef) => hasPin(pins, entry), [pins]);

  return { recents, pins, recordRecent, togglePin, isPinned };
}
