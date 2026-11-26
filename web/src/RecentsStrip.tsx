// Compact Recents / Pinned quick-jump strip and row pin button.

import { sameQuickJumpRef, type QuickJumpRef } from "./recents-pins";

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

export function RecentsStrip({
  pinned,
  recents,
  activeRef,
  onSelect,
  onUnpin,
  className,
}: {
  pinned: StripEntry[];
  recents: StripEntry[];
  activeRef: QuickJumpRef | null;
  onSelect: (ref: QuickJumpRef) => void;
  onUnpin: (ref: QuickJumpRef) => void;
  className?: string;
}) {
  if (pinned.length === 0 && recents.length === 0) return null;

  return (
    <div className={className ? `recents-strip ${className}` : "recents-strip"} role="region" aria-label="Pinned and recent">
      <div className="recents-strip-scroll">
        {pinned.length > 0 ? (
          <span className="recents-group-label">Pinned</span>
        ) : null}
        {pinned.map((entry) => {
          const active = activeRef !== null && sameQuickJumpRef(activeRef, entry.ref);
          return (
            <span key={`pin-${entry.ref.kind}-${entry.ref.id}`} className={`recents-chip-group is-pinned${active ? " is-active" : ""}`}>
              <button
                type="button"
                className="recents-chip"
                aria-current={active ? "true" : undefined}
                title={entry.label}
                onClick={() => onSelect(entry.ref)}
              >
                <PinIcon filled />
                <span className="recents-chip-label">{entry.label}</span>
                {entry.badge ? <span className="recents-chip-badge">{entry.badge}</span> : null}
              </button>
              <button
                type="button"
                className="recents-chip-unpin"
                aria-label={`Unpin ${entry.label}`}
                title="Unpin"
                onClick={() => onUnpin(entry.ref)}
              >
                ×
              </button>
            </span>
          );
        })}
        {pinned.length > 0 && recents.length > 0 ? <span className="recents-divider" aria-hidden="true" /> : null}
        {recents.length > 0 ? (
          <span className="recents-group-label">Recent</span>
        ) : null}
        {recents.map((entry) => {
          const active = activeRef !== null && sameQuickJumpRef(activeRef, entry.ref);
          return (
            <button
              key={`recent-${entry.ref.kind}-${entry.ref.id}`}
              type="button"
              className={`recents-chip recents-chip-solo${active ? " is-active" : ""}`}
              aria-current={active ? "true" : undefined}
              title={entry.label}
              onClick={() => onSelect(entry.ref)}
            >
              <span className="recents-chip-label">{entry.label}</span>
              {entry.badge ? <span className="recents-chip-badge">{entry.badge}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
