import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { achievements } from "./progress-celebration";
import type { ProgressCounts } from "./progress-celebration";

export function ProgressCelebration({ eventVersion, onView }: { eventVersion: number; onView: () => void }) {
  const previous = useRef<ProgressCounts | null>(null);
  const [message, setMessage] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.progression().then(value => {
      if (cancelled) return;
      if (previous.current) {
        const earned = achievements(previous.current, value);
        if (earned.length) setMessage(earned);
      }
      previous.current = value;
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [eventVersion]);
  return message.length ? <div className="progress-celebration" role="status"><strong>Achievement unlocked!</strong><span>{message.join(' · ')}</span><button type="button" onClick={() => { setMessage([]); onView(); }}>View progress</button><button type="button" aria-label="Dismiss achievement" onClick={() => setMessage([])}>×</button></div> : null;
}
