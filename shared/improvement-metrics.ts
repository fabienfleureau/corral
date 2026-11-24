// Shapes of GET /api/improvement/metrics, shared by the server and the UI.

export interface RateCounts {
  dispatches: number;
  escalations: number;
  /** escalations / dispatches, null without dispatches. */
  rate: number | null;
}

/** Stopped or failed runs escalated to the inbox, per dispatch and harness. */
export interface StoppedRunRate {
  pivot_ms: number;
  days: number;
  before: { start_ms: number; end_ms: number };
  after: { start_ms: number; end_ms: number };
  total: { before: RateCounts; after: RateCounts };
  by_harness: { harness: string; before: RateCounts; after: RateCounts }[];
  /** How the counted escalations were recognised. */
  sources: { marker: number; capture_event: number; title: number };
}


export interface WaitStats {
  count: number;
  /** Nearest-rank percentiles, null without samples. */
  p50_ms: number | null;
  p90_ms: number | null;
}

/** Agent time (first dispatch → first ready for review) and reviewer time
 *  (first ready → resolved) of PR-backed tasks. */
export interface PrWaitRow {
  repo: string;
  prs: number;
  agent: WaitStats;
  reviewer: WaitStats;
  /** Ready but not resolved yet: not in the reviewer stats. */
  awaiting_review: number;
}

export interface PrWaitSplit {
  since_ms: number;
  until_ms: number;
  days: number;
  total: PrWaitRow;
  by_repo: PrWaitRow[];
  /** PR items created in the window that never became ready. */
  never_ready: number;
}

export interface ImprovementMetrics {
  stopped_runs: StoppedRunRate;
  pr_wait: PrWaitSplit;
}
