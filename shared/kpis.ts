export const KPI_IDS = ["kpi-1", "kpi-2"] as const;
export type KpiId = typeof KPI_IDS[number];

export interface KpiSettings {
  name: string;
  definition: string;
  unit: string;
  sources: string;
  /** Working directory for the read-only cycle; any absolute folder path. */
  repoPath: string;
  /** Configured favorite supplying harness, agent, model and reasoning. */
  favorite: string;
  intervalHours: 0 | 1 | 24;
  /** Persistent product context, caveats and constraints saved across cycles. */
  context: string;
  /** Optional target the agent works towards. */
  goal: KpiGoal | null;
}

export interface KpiGoal {
  /** Target value, in the KPI unit. */
  target: number;
  direction: "increase" | "decrease";
  /** YYYY-MM-DD UTC. */
  deadline: string;
  /** Why the goal matters and its constraints. */
  why: string;
}

/** Measurement recorded when the goal was set, or the first one after. */
export interface KpiBaseline {
  value: number;
  /** End of the measurement window (YYYY-MM-DD, exclusive). */
  to: string;
}

/** Computed by Corral from the baseline, the target and the last measurement. */
export interface KpiGoalProgress {
  baseline: KpiBaseline | null;
  /** target − last measured value; null without a measurement. */
  gap: number | null;
  /** Share of the way from baseline to target (1 = reached); null when unknown. */
  progress: number | null;
  reached: boolean;
}

export interface KpiTrajectory {
  onTrack: "yes" | "no" | "unknown";
  confidence: "high" | "medium" | "low";
  rationale: string;
}

export interface KpiGoalReview {
  verdict: "realistic" | "ambitious" | "unrealistic" | "unmeasurable";
  rationale: string;
}

export interface KpiMeasurement {
  value: number;
  from: string;
  to: string;
  sources: string[];
}

export interface KpiReport {
  summary: string;
  measurement: KpiMeasurement | null;
  dataNeeds: string[];
  productQuestions: string[];
  proposals: { title: string; rationale: string; evidence: string }[];
  memory: string;
  /** Present when the KPI has a goal. Reports saved before goals lack them. */
  trajectory?: KpiTrajectory | null;
  goalReview?: KpiGoalReview | null;
}

export interface KpiView {
  id: KpiId;
  settings: KpiSettings;
  runState: "starting" | "running" | "blocked" | "complete" | "failed" | null;
  address: string | null;
  sessionUrl: string | null;
  error: string | null;
  startedMs: number | null;
  reportMs: number | null;
  nextRunMs: number | null;
  report: KpiReport | null;
  lastMeasurement: KpiMeasurement | null;
  /** Null without a goal. */
  goalProgress: KpiGoalProgress | null;
  /** Sourced measurements, oldest first, latest window per period. */
  history: KpiMeasurement[];
}
