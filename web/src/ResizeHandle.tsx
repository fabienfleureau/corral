// Draggable, keyboard-operable divider between a pane and its neighbour.
// It is a flex sibling of the pane (not a child), so the pane's own overflow
// never clips the grab area. Pane on the left, neighbour on the right.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { clampWidth, effectiveLimits, keyboardWidth } from "./pane-size";
import type { PaneLimits } from "./pane-size";

type Props = {
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
  width: number;
  limits: PaneLimits;
  /** Pixels the neighbouring content must keep while this pane grows. */
  reserve: number;
  onChange: (width: number) => void;
  onReset: () => void;
};

export function ResizeHandle({ label, width, limits, reserve, onChange, onReset }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startWidth: number; limits: PaneLimits } | null>(null);
  const [dragging, setDragging] = useState(false);

  // One cursor for the whole page while dragging, so it does not flicker over
  // other elements, and text is not selected along the way.
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.classList.add("is-resizing");
    return () => document.documentElement.classList.remove("is-resizing");
  }, [dragging]);

  const currentLimits = () => effectiveLimits(limits, ref.current?.parentElement?.clientWidth ?? 0, reserve);

  // What is on screen, not the stored width: a CSS max-width can hold the pane
  // narrower than the stored value, and the divider must follow the pointer
  // from where it really is.
  const renderedWidth = () => {
    const pane = ref.current?.previousElementSibling;
    return pane ? Math.round(pane.getBoundingClientRect().width) : width;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: renderedWidth(), limits: currentLimits() };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    onChange(clampWidth(current.startWidth + event.clientX - current.startX, current.limits));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onReset();
      return;
    }
    const next = keyboardWidth(event.key, renderedWidth(), currentLimits(), event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };

  return (
    <div
      ref={ref}
      className={`resize-handle ${dragging ? "resize-handle-active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
