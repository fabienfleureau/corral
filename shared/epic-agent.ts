export type EpicAgentStepStatus = "done" | "in_progress" | "pending" | "blocked";
export type EpicAgentE2eStatus = "passed" | "failed" | "skipped" | "not_applicable";
export type EpicAgentRunState = "starting" | "running" | "blocked" | "complete" | "failed";

export interface EpicAgentSettings {
  /** Working directory for the autonomous epic cycle; any absolute folder path. */
  repoPath: string;
  /** Configured favorite supplying harness, agent, model and reasoning. */
  favorite: string;
  /** Automatic run cadence: 0 off, 1 hourly, 24 daily. */
  intervalHours: 0 | 1 | 24;
  /** Persistent operator context, conventions and constraints saved across cycles. */
  context: string;
}

export interface EpicAgentStep {
  title: string;
  status: EpicAgentStepStatus;
  details: string;
  ticketKey: string | null;
}

export interface EpicAgentE2e {
  status: EpicAgentE2eStatus;
  summary: string;
  commands: string[];
  gaps: string[];
}

export interface EpicAgentReport {
  summary: string;
  steps: EpicAgentStep[];
  actionsTaken: string[];
  problems: string[];
  specGaps: string[];
  clarifications: string[];
  e2e: EpicAgentE2e | null;
  nextSteps: string[];
  memory: string;
}

export interface EpicAgentView {
  epicId: string;
  settings: EpicAgentSettings;
  runState: EpicAgentRunState | null;
  address: string | null;
  sessionUrl: string | null;
  error: string | null;
  startedMs: number | null;
  reportMs: number | null;
  nextRunMs: number | null;
  report: EpicAgentReport | null;
}
