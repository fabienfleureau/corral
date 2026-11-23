// Pure view-model helpers for the sidebar quota rings.

import type { AgentQuota } from "./types.ts";

export const QUOTA_AGENT_ORDER: readonly AgentQuota["agent"][] = [
  "claude",
  "codex",
  "opencode-go",
  "google",
];

export const QUOTA_AGENT_LABELS: Record<AgentQuota["agent"], string> = {
  claude: "Claude",
  codex: "Codex",
  "opencode-go": "OpenCode Go",
  google: "Google",
};

export type QuotaRingTone = "ok" | "warn" | "hot";

export type SidebarQuotaRing = {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  tone: QuotaRingTone;
  resetsMs: number | null;
};

export type SidebarQuotaGauge = {
  agent: AgentQuota["agent"];
  label: string;
  plan: string | null;
  stale: boolean;
  /** Up to 2 rings rendered concentrically: [outer] or [outer, inner]. */
  rings: SidebarQuotaRing[];
  /** Every window returned by the provider, for tooltip details. */
  windows: SidebarQuotaRing[];
  asOfMs: number | null;
  note: string | null;
};

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function remainingPercent(usedPercent: number): number {
  return clampPercent(100 - clampPercent(usedPercent));
}

export function quotaTone(usedPercent: number): QuotaRingTone {
  const used = clampPercent(usedPercent);
  if (used >= 90) return "hot";
  if (used >= 70) return "warn";
  return "ok";
}

export function formatResetIn(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const diff = ms - now;
  if (diff <= 0) return "reset passed";
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 48) return `resets in ${Math.round(hours / 24)}d`;
  if (hours >= 1) return `resets in ${hours}h ${Math.floor((diff % 3_600_000) / 60_000)}m`;
  return `resets in ${Math.ceil(diff / 60_000)}m`;
}

/** Convert raw quota snapshots into sidebar gauges, keeping only providers with data. */
export function buildSidebarQuotaGauges(quotas: AgentQuota[] | null | undefined): SidebarQuotaGauge[] {
  if (!quotas || quotas.length === 0) return [];
  const byAgent = new Map(quotas.map((q) => [q.agent, q]));
  const gauges: SidebarQuotaGauge[] = [];
  for (const agent of QUOTA_AGENT_ORDER) {
    const q = byAgent.get(agent);
    if (!q || q.windows.length === 0) continue;
    const windows: SidebarQuotaRing[] = q.windows.map((w) => {
      const used = clampPercent(w.used_percent);
      return {
        label: w.label,
        usedPercent: used,
        remainingPercent: remainingPercent(used),
        tone: quotaTone(used),
        resetsMs: w.resets_ms,
      };
    });
    gauges.push({
      agent,
      label: QUOTA_AGENT_LABELS[agent],
      plan: q.plan,
      stale: q.stale,
      rings: windows.slice(0, 2),
      windows,
      asOfMs: q.as_of_ms,
      note: q.note,
    });
  }
  return gauges;
}

export function quotaAriaLabel(gauge: SidebarQuotaGauge): string {
  const summary = gauge.windows
    .map((w) => `${w.label} ${Math.round(w.remainingPercent)}% left`)
    .join(", ");
  const staleNote = gauge.stale ? " (stale)" : "";
  return `${gauge.label} quota${staleNote}: ${summary}. Open Usage`;
}
