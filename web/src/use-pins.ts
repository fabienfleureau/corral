// Browser-local persistence for the pinned quick-jump strip.

import { useCallback, useState } from "react";
import {
  isPinned as hasPin,
  parseStoredPins,
  togglePin as togglePinEntry,
  type QuickJumpRef,
} from "./pins";

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: QuickJumpRef[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* Storage may be unavailable (private window, blocked site data). */ }
}

export function usePins(pinsKey: string) {
  const [pins, setPins] = useState<QuickJumpRef[]>(() => parseStoredPins(readStorage(pinsKey)));

  const togglePin = useCallback((entry: QuickJumpRef) => {
    setPins((prev) => {
      const next = togglePinEntry(prev, entry);
      writeStorage(pinsKey, next);
      return next;
    });
  }, [pinsKey]);

  const isPinned = useCallback((entry: QuickJumpRef) => hasPin(pins, entry), [pins]);

  return { pins, togglePin, isPinned };
}
