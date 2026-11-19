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

export type KpiImpact = "high" | "medium" | "low";
export type KpiEffort = "S" | "M" | "L";

/** A data need or product question. The id stays stable across cycles so the
 *  inbox asks once. Reports saved before ids carry plain strings. */
export interface KpiAsk {
  id: string;
  text: string;
}

/** An unproven hypothesis that could move the KPI towards its goal. */
export interface KpiIdea {
  id: string;
  hypothesis: string;
  expectedImpact: string;
  /** How a later cycle can confirm or reject it. */
  verification: string;
  impact: KpiImpact;
  effort: KpiEffort;
  status: "open" | "confirmed" | "rejected";
  /** Why it was confirmed or rejected. */
  reason: string;
}

export interface KpiProposal {
  title: string;
  rationale: string;
  evidence: string;
  /** Missing on reports saved before prioritisation. */
  impact?: KpiImpact;
  effort?: KpiEffort;
}

/** An inbox answer or a dismissed idea, sent to the next cycles. */
export interface KpiFeedback {
  kind: "answer" | "dismissed-idea";
  /** Question or idea id. */
  ref: string;
  /** The question or idea as the operator saw it. */
  subject: string;
  answer: string;
  at: string;
}

export interface KpiReport {
  summary: string;
  measurement: KpiMeasurement | null;
  dataNeeds: (KpiAsk | string)[];
  productQuestions: (KpiAsk | string)[];
  /** Missing on reports saved before ideas. */
  ideas?: KpiIdea[];
  proposals: KpiProposal[];
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
  /** Inbox answers and dismissed ideas, oldest first. */
  feedback: KpiFeedback[];
}
