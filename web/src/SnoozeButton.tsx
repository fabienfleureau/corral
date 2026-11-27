// Two-click snooze button: a trigger opens a viewport-aware popover of duration
// presets (1h, 4h, Tomorrow), then closes on pick or light-dismiss.

import { useEffect, useId, useRef, useState } from "react";
import { SNOOZE_PRESETS, type SnoozePreset } from "./util";

export { SNOOZE_PRESETS, type SnoozePreset };

function positionPopoverFallback(trigger: HTMLElement, popover: HTMLElement) {
  const tr = trigger.getBoundingClientRect();
  const pr = popover.getBoundingClientRect();
  const margin = 8;
  const gap = 6;
  const below = tr.bottom + gap;
  const top = below + pr.height <= window.innerHeight - margin
    ? below
    : Math.max(margin, tr.top - pr.height - gap);
  const left = Math.min(
    Math.max(margin, tr.left),
    Math.max(margin, window.innerWidth - pr.width - margin),
  );
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

/** Trigger button + popover group for picking a snooze duration in two clicks. */
export function SnoozeButton({
  disabled = false,
  onSnooze,
}: {
  disabled?: boolean;
  onSnooze: (preset: SnoozePreset) => void;
}) {
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const supportsPopover = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover || !supportsPopover) return;
    const onToggle = (event: Event) => {
      const nextOpen = (event as ToggleEvent).newState === "open";
      setOpen(nextOpen);
      if (nextOpen && !CSS.supports("position-area: block-end") && triggerRef.current) {
        positionPopoverFallback(triggerRef.current, popover);
      }
    };
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, [supportsPopover]);

  useEffect(() => {
    if (!disabled) return;
    if (supportsPopover) {
      const popover = popoverRef.current;
      if (popover?.matches(":popover-open")) popover.hidePopover();
    } else {
      setOpen(false);
    }
  }, [disabled, supportsPopover]);

  const pick = (preset: SnoozePreset) => {
    if (supportsPopover) {
      const popover = popoverRef.current;
      if (popover?.matches(":popover-open")) popover.hidePopover();
    } else {
      setOpen(false);
    }
    onSnooze(preset);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn snooze-trigger"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={popoverId}
        {...(supportsPopover
          ? { popoverTarget: popoverId }
          : { onClick: () => setOpen((v) => !v) })}
      >
        Snooze
        <svg className="snooze-caret" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div
        ref={popoverRef}
        id={popoverId}
        className="snooze-popover"
        role="group"
        aria-label="Snooze duration"
        {...(supportsPopover ? { popover: "auto" } : { hidden: !open })}
      >
        {SNOOZE_PRESETS.map(({ preset, label }) => (
          <button
            key={preset}
            type="button"
            className="btn snooze-option"
            disabled={disabled}
            onClick={() => pick(preset)}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
