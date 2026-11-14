// Persisted pane state: a column width and a collapsed flag, kept per browser.

import { useCallback, useEffect, useRef, useState } from "react";
import { clampWidth, parseStoredFlag, parseStoredWidth } from "./pane-size";
import type { PaneLimits } from "./pane-size";

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* Storage may be unavailable (private window, blocked site data). */ }
}

/**
 * A column width that survives reloads. Nothing is stored until the user
 * resizes, so a later change of the default still reaches people who never did.
 */
export function usePaneWidth(storageKey: string, defaultWidth: number, limits: PaneLimits) {
  const [width, setWidthState] = useState(() => parseStoredWidth(readStorage(storageKey), limits, defaultWidth));
  const touched = useRef(false);

  const setWidth = useCallback((next: number) => {
    touched.current = true;
    setWidthState(clampWidth(next, limits));
  }, [limits]);

  const reset = useCallback(() => {
    touched.current = false;
    setWidthState(defaultWidth);
    writeStorage(storageKey, null);
  }, [defaultWidth, storageKey]);

  useEffect(() => {
    if (touched.current) writeStorage(storageKey, String(width));
  }, [storageKey, width]);

  return { width, setWidth, reset };
}

/** A boolean (collapsed, open…) that survives reloads. */
export function usePaneFlag(storageKey: string): [boolean, (next: boolean) => void] {
  const [flag, setFlagState] = useState(() => parseStoredFlag(readStorage(storageKey)));
  const setFlag = useCallback((next: boolean) => {
    setFlagState(next);
    writeStorage(storageKey, next ? "1" : "0");
  }, [storageKey]);
  return [flag, setFlag];
}
