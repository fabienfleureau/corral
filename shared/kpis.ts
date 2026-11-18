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
}
