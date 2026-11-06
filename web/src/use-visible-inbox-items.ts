import { useEffect, useState } from "react";
import type { Item } from "./types";
import { visibleInboxItems } from "./inbox-selection";

export function useVisibleInboxItems(items: Item[]): Item[] {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { setNow(Date.now()); }, [items]);
  useEffect(() => {
    const current = Date.now();
    const deadlines = items.flatMap((item) => item.status === "open" && item.snooze_until_ms !== null && item.snooze_until_ms > current ? [item.snooze_until_ms] : []);
    if (deadlines.length === 0) return;
    const delay = Math.min(Math.min(...deadlines) - current, 2_147_483_647);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [items, now]);
  return visibleInboxItems(items, now);
}
