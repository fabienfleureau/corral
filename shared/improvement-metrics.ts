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
  /** Windows start no earlier than this: before it, stopped runs left no inbox item. */
  detection_start_ms: number;
  days: number;
  before: { start_ms: number; end_ms: number };
  after: { start_ms: number; end_ms: number };
  total: { before: RateCounts; after: RateCounts };
  by_harness: { harness: string; before: RateCounts; after: RateCounts }[];
  /** How the counted escalations were recognised. */
  sources: { marker: number; capture_event: number; title: number };
}

export interface ImprovementMetrics {
  stopped_runs: StoppedRunRate;
}
