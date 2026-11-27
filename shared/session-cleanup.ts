// Shared types for scheduled orphaned-session analysis and cleanup.
// Keep erasable-syntax-only (no enums, no parameter properties).

export type SessionCleanupReason =
  | "terminal_task"
  | "superseded_task"
  | "missing_task"
  | "finished_kpi"
  | "finished_epic_agent"
  | "orphaned_child"
  | "unlinked_corral"
  | "stale_dispatched";

export type SessionCleanupAction =
  | "archived"
  | "worktree_cleaned"
  | "killed"
  | "would_clean"
  | "failed"
  | "warning";

export interface SessionCleanupItem {
  address: string;
  name: string | null;
  harness: string | null;
  status: string | null;
  task_id: string | null;
  task_title: string | null;
  created_ms: number;
  reason: SessionCleanupReason;
  detail: string;
  action: SessionCleanupAction;
  error?: string;
}

export interface SessionCleanupReport {
  id: string;
  ran_ms: number;
  dry_run: boolean;
  trigger: "scheduled" | "manual";
  scanned: number;
  corral_owned: number;
  external_ignored: number;
  kept_active: number;
  cleaned: number;
  would_clean: number;
  failed: number;
  warnings: number;
  by_reason: Partial<Record<SessionCleanupReason, number>>;
  items: SessionCleanupItem[];
}

export interface SessionCleanupConfig {
  enabled: boolean;
  intervalMinutes: number;
  graceMinutes: number;
  staleDispatchedHours: number;
}

export interface SessionCleanupStatus {
  config: SessionCleanupConfig;
  running: boolean;
  lastRun: SessionCleanupReport | null;
  history: SessionCleanupReport[];
}

export const SESSION_CLEANUP_REASON_LABELS: Record<SessionCleanupReason, string> = {
  terminal_task: "Terminal task",
  superseded_task: "Superseded session",
  missing_task: "Missing task",
  finished_kpi: "Finished KPI cycle",
  finished_epic_agent: "Finished epic agent",
  orphaned_child: "Orphaned sub-agent",
  unlinked_corral: "Unlinked Corral session",
  stale_dispatched: "Stale dispatched task",
};
