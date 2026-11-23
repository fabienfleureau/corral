// Sidebar quota gauges — concentric progress rings around each provider mark,
// with an accessible hover/focus tooltip and click-through to #/usage.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { AgentQuota } from "./types";
import { timeAgo } from "./util";
import { buildSidebarQuotaGauges, formatResetIn, quotaAriaLabel } from "./sidebar-quotas";
import type { SidebarQuotaGauge } from "./sidebar-quotas";

function ProviderMark({ agent }: { agent: AgentQuota["agent"] }) {
  if (agent === "claude") {
    // Anthropic / Claude starburst mark
    return (
      <svg className="sidebar-quota-mark sidebar-quota-mark-claude" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12.9 2.3 12 9.4l-2.6-6.6-1.9.9 3.4 6.2-5.7-4-1.3 1.6 6.2 3.3-7-.5-.2 2.1 7 .1-6.2 3.4 1.1 1.8 5.9-3.9-3.2 6.3 1.9.9 2.5-6.6.9 7.1 2.1-.2-.8-7 5.5 4.4 1.4-1.6-5.9-3.7 7 .9.3-2.1-7-.4 6.4-3-1-1.9-6 3.5 3.6-6.1-1.8-1-3 6.4.6-7.1z"
        />
      </svg>
    );
  }
  if (agent === "codex") {
    // OpenAI hexagonal knot mark
    return (
      <svg
        className="sidebar-quota-mark"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 2.75a4.5 4.5 0 0 1 4.17 2.81 4.5 4.5 0 0 1 3.74 6.42 4.5 4.5 0 0 1-1.65 6.82 4.5 4.5 0 0 1-6.26 2.45 4.5 4.5 0 0 1-6.42-1.56 4.5 4.5 0 0 1-1.64-6.9A4.5 4.5 0 0 1 7.83 5.56 4.5 4.5 0 0 1 12 2.75Z" />
        <polygon points="12,8.4 15.1,10.2 15.1,13.8 12,15.6 8.9,13.8 8.9,10.2" />
        <path d="M12 8.4V4.2M15.1 10.2l3.6-2.1M15.1 13.8l3.6 2.1M12 15.6v4.2M8.9 13.8l-3.6 2.1M8.9 10.2 5.3 8.1" />
      </svg>
    );
  }
  if (agent === "opencode-go") {
    // OpenCode nested-rectangle mark
    return (
      <svg className="sidebar-quota-mark" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" fillRule="evenodd" d="M5 3h14v18H5V3Zm3.5 3.5v11h7v-11h-7Z" />
        <rect x="8.5" y="11" width="7" height="6.5" fill="currentColor" opacity="0.38" />
      </svg>
    );
  }
  // Google / Gemini four-point sparkle mark
  return (
    <svg className="sidebar-quota-mark sidebar-quota-mark-google" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2.5c.8 5.2 4.3 8.7 9.5 9.5-5.2.8-8.7 4.3-9.5 9.5-.8-5.2-4.3-8.7-9.5-9.5 5.2-.8 8.7-4.3 9.5-9.5Z"
      />
    </svg>
  );
}

type TooltipState = {
  agent: AgentQuota["agent"];
  top: number;
  left: number;
  instant: boolean;
};

export function SidebarQuotas({
  quotas,
  onOpenUsage,
}: {
  quotas: AgentQuota[] | null;
  onOpenUsage: () => void;
}) {
  const gauges = buildSidebarQuotaGauges(quotas);
  const baseId = useId();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAgent = useRef<AgentQuota["agent"] | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // WCAG 1.4.13 Dismissible: Escape closes the tooltip without moving focus.
  useEffect(() => {
    if (!tooltip) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        clearTimers();
        activeAgent.current = null;
        setTooltip(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tooltip, clearTimers]);

  const showFor = useCallback(
    (agent: AgentQuota["agent"], target: HTMLElement, immediate: boolean) => {
      clearTimers();
      const rect = target.getBoundingClientRect();
      const top = Math.max(12, Math.min(window.innerHeight - 12, rect.top + rect.height / 2));
      const left = rect.right + 10;
      const alreadyOpen = activeAgent.current !== null;
      const openNow = () => {
        activeAgent.current = agent;
        setTooltip({ agent, top, left, instant: alreadyOpen });
      };
      if (immediate || alreadyOpen) {
        openNow();
      } else {
        openTimer.current = setTimeout(openNow, 150);
      }
    },
    [clearTimers],
  );

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => {
      activeAgent.current = null;
      setTooltip(null);
    }, 100);
  }, [clearTimers]);

  const keepOpen = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  if (gauges.length === 0) return null;

  const activeGauge: SidebarQuotaGauge | null = tooltip
    ? gauges.find((g) => g.agent === tooltip.agent) ?? null
    : null;
  const tooltipId = `${baseId}-tooltip`;

  return (
    <div className="sidebar-quotas" role="region" aria-label="Provider quotas">
      {gauges.map((gauge) => {
        const isCurrent = activeGauge?.agent === gauge.agent;
        return (
          <button
            key={gauge.agent}
            type="button"
            className={`sidebar-quota-btn ${gauge.stale ? "sidebar-quota-stale" : ""}`}
            aria-label={quotaAriaLabel(gauge)}
            aria-describedby={isCurrent ? tooltipId : undefined}
            onClick={onOpenUsage}
            onPointerEnter={(ev) => {
              if (ev.pointerType !== "touch") showFor(gauge.agent, ev.currentTarget, false);
            }}
            onPointerLeave={scheduleClose}
            onFocus={(ev) => showFor(gauge.agent, ev.currentTarget, true)}
            onBlur={scheduleClose}
          >
            <span className="sidebar-quota-rings">
              {gauge.rings.map((ring, idx) => (
                <progress
                  key={ring.label}
                  className={`quota-ring quota-ring-${idx === 0 ? "outer" : "inner"} quota-ring-${ring.tone}`}
                  value={Math.round(ring.remainingPercent)}
                  max={100}
                  aria-hidden="true"
                  tabIndex={-1}
                  style={{ "--value": ring.remainingPercent } as CSSProperties}
                />
              ))}
              <span className="sidebar-quota-icon" aria-hidden="true">
                <ProviderMark agent={gauge.agent} />
              </span>
            </span>
          </button>
        );
      })}
      {activeGauge && tooltip ? (
        <div
          id={tooltipId}
          role="tooltip"
          className={`sidebar-quota-tooltip ${tooltip.instant ? "sidebar-quota-tooltip-instant" : ""}`}
          style={{ top: tooltip.top, left: tooltip.left }}
          onPointerEnter={keepOpen}
          onPointerLeave={scheduleClose}
        >
          <div className="sidebar-quota-tooltip-head">
            <strong>{activeGauge.label}</strong>
            {activeGauge.plan ? <span className="badge badge-mute">{activeGauge.plan}</span> : null}
            {activeGauge.stale ? <span className="badge badge-wait">stale</span> : null}
          </div>
          <div className="sidebar-quota-tooltip-rows">
            {activeGauge.windows.map((w) => {
              const reset = formatResetIn(w.resetsMs);
              return (
                <div key={w.label} className="sidebar-quota-tooltip-row">
                  <div className="sidebar-quota-tooltip-label">
                    <span>{w.label}</span>
                    <span className={`sidebar-quota-pct sidebar-quota-pct-${w.tone}`}>
                      {Math.round(w.remainingPercent)}% left
                    </span>
                  </div>
                  <div className="sidebar-quota-tooltip-bar">
                    <div
                      className={`sidebar-quota-tooltip-fill sidebar-quota-fill-${w.tone}`}
                      style={{ width: `${w.remainingPercent}%` }}
                    />
                  </div>
                  {reset ? <div className="sidebar-quota-tooltip-reset muted">{reset}</div> : null}
                </div>
              );
            })}
          </div>
          {activeGauge.asOfMs ? (
            <div className="sidebar-quota-tooltip-foot muted">
              Updated {timeAgo(activeGauge.asOfMs)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
