// A clock reading that only changes when a peak window opens or closes, so the
// components using it re-render twice a window instead of every tick.

import { useEffect, useState } from "react";
import { isPeakNow } from "./peak-hours";

const TICK_MS = 30_000;

export function usePeakNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow((prev) => {
      const next = new Date();
      return isPeakNow(prev) === isPeakNow(next) ? prev : next;
    });
    // An interval, not a timeout to the next boundary: it also catches up after sleep.
    const timer = window.setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return now;
}
