export const KPIS = {
  "qovery-side": { title: "Qovery-side deployment failure rate", unit: "%" },
  tier1: { title: "Tier 1 organisations above 2% failed deployments (4 weeks)", unit: "organisations" },
} as const;

export type KpiId = keyof typeof KPIS;
export const KPI_IDS = Object.keys(KPIS) as KpiId[];

export interface KpiSettings {
  agent: string;
  harness: string;
  repo: string;
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
