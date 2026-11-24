// Pure view-model helpers for the sidebar quota rings.

import type { AgentQuota, QuotaPrediction } from "./types.ts";

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

export type QuotaRingTone = "ok" | "caution" | "warn" | "hot";

export type SidebarQuotaRing = {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  tone: QuotaRingTone;
  resetsMs: number | null;
  prediction: QuotaPrediction | null;
};

export type SidebarQuotaGauge = {
  agent: AgentQuota["agent"];
  label: string;
  plan: string | null;
  stale: boolean;
  /** True when any higher quota window is projected to hit 100% before reset. */
  willHit: boolean;
  /** Up to 2 rings rendered concentrically: [outer] or [outer, inner]. The two
   *  most-used windows, so a spent third window (OpenCode Go monthly) still shows. */
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
  if (used >= 75) return "warn";
  if (used >= 50) return "caution";
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

export function formatDurationShort(ms: number): string {
  if (ms <= 0) return "now";
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  if (hours >= 48) return `~${Math.round(hours / 24)}d`;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `~${days}d ${remHours}h` : `~${days}d`;
  }
  if (hours >= 12) return `~${Math.round(totalMinutes / 60)}h`;
  if (hours >= 1) {
    const mins = totalMinutes % 60;
    return mins > 0 ? `~${hours}h ${mins}m` : `~${hours}h`;
  }
  return `~${totalMinutes}m`;
}

export function formatQuotaPrediction(prediction: QuotaPrediction): string {
  if (prediction.status === "hit") return "Limit hit (100%)";
  const pctText = prediction.projected_percent > 300 ? ">300%" : `~${Math.round(prediction.projected_percent)}%`;
  if (prediction.status === "will_hit") {
    const when = prediction.hits_in_ms !== null ? formatDurationShort(prediction.hits_in_ms) : "before reset";
    return `Hits in ${when} (${pctText} pace)`;
  }
  if (prediction.status === "close") return `Close · ${pctText} by reset`;
  return `On track · ${pctText} by reset`;
}

export function quotaPredictionDetail(prediction: QuotaPrediction): string {
  if (prediction.status === "hit") return "Quota exhausted (100% used)";
  const basisLabel = prediction.basis === "curve" ? "current usage curve" : "window pace";
  return `Projected ~${Math.round(prediction.projected_percent)}% by reset at ${prediction.rate_per_day.toFixed(1)}%/day (based on ${basisLabel})`;
}

/** The `count` most-used windows, kept in provider order. Ties keep the earlier window. */
function mostUsed(windows: SidebarQuotaRing[], count: number): SidebarQuotaRing[] {
  const keep = new Set(
    windows
      .map((w, i) => ({ w, i }))
      .sort((a, b) => b.w.usedPercent - a.w.usedPercent || a.i - b.i)
      .slice(0, count)
      .map(({ w }) => w),
  );
  return windows.filter((w) => keep.has(w));
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
        prediction: w.prediction ?? null,
      };
    });
    gauges.push({
      agent,
      label: QUOTA_AGENT_LABELS[agent],
      plan: q.plan,
      stale: q.stale,
      willHit: windows.some((w) => w.prediction?.status === "will_hit"),
      rings: mostUsed(windows, 2),
      windows,
      asOfMs: q.as_of_ms,
      note: q.note,
    });
  }
  return gauges;
}

export function quotaAriaLabel(gauge: SidebarQuotaGauge): string {
  const summary = gauge.windows
    .map((w) => {
      const base = `${w.label} ${Math.round(w.remainingPercent)}% left`;
      return w.prediction ? `${base} (${formatQuotaPrediction(w.prediction)})` : base;
    })
    .join(", ");
  const staleNote = gauge.stale ? " (stale)" : "";
  return `${gauge.label} quota${staleNote}: ${summary}. Open Usage`;
}
