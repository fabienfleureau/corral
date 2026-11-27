// Compact pinned quick-jump strip and row pin button.

import { sameQuickJumpRef, type QuickJumpRef } from "./pins";

export type StripEntry = {
  ref: QuickJumpRef;
  label: string;
  badge?: string;
};

export function PinIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      className="pin-icon"
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5.5 2.5h5l-.8 3.6 2 2v1.2H8.5v4.2l-.5.8-.5-.8V9.3H4.3V8.1l2-2-.8-3.6Z" />
    </svg>
  );
}

export function PinButton({ pinned, label, onToggle }: { pinned: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`pin-btn${pinned ? " is-pinned" : ""}`}
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
      title={pinned ? "Unpin" : "Pin"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <PinIcon filled={pinned} />
    </button>
  );
}

export function PinnedStrip({
  pinned,
  activeRef,
  onSelect,
  onUnpin,
  className,
}: {
  pinned: StripEntry[];
  activeRef: QuickJumpRef | null;
  onSelect: (ref: QuickJumpRef) => void;
  onUnpin: (ref: QuickJumpRef) => void;
  className?: string;
}) {
  if (pinned.length === 0) return null;

  return (
    <div className={className ? `pinned-strip ${className}` : "pinned-strip"} role="region" aria-label="Pinned">
      <div className="pinned-strip-scroll">
        <span className="pinned-group-label">Pinned</span>
        {pinned.map((entry) => {
          const active = activeRef !== null && sameQuickJumpRef(activeRef, entry.ref);
          return (
            <span key={`pin-${entry.ref.kind}-${entry.ref.id}`} className={`pinned-chip-group is-pinned${active ? " is-active" : ""}`}>
              <button
                type="button"
                className="pinned-chip"
                aria-current={active ? "true" : undefined}
                title={entry.label}
                onClick={() => onSelect(entry.ref)}
              >
                <PinIcon filled />
                <span className="pinned-chip-label">{entry.label}</span>
                {entry.badge ? <span className="pinned-chip-badge">{entry.badge}</span> : null}
              </button>
              <button
                type="button"
                className="pinned-chip-unpin"
                aria-label={`Unpin ${entry.label}`}
                title="Unpin"
                onClick={() => onUnpin(entry.ref)}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
