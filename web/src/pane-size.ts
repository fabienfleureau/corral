// Width rules for the resizable columns (sidebar, inbox list). Pure, so the
// drag/keyboard/storage behaviour is testable without a DOM.

export type PaneLimits = { min: number; max: number };

/** Arrow-key step; Shift multiplies it for coarse moves. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

export function clampWidth(width: number, { min, max }: PaneLimits): number {
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * The limits for one drag: the configured max, trimmed so the neighbouring
 * content keeps `reserve` pixels. The min always wins on a tiny container.
 */
export function effectiveLimits(limits: PaneLimits, containerWidth: number, reserve: number): PaneLimits {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return limits;
  return { min: limits.min, max: Math.max(limits.min, Math.min(limits.max, containerWidth - reserve)) };
}

/** A stored width, or the default when it is missing, malformed or out of range. */
export function parseStoredWidth(raw: string | null, limits: PaneLimits, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < limits.min || value > limits.max) return fallback;
  return Math.round(value);
}

export function parseStoredFlag(raw: string | null): boolean {
  return raw === "1";
}

/** Arrow keys follow the handle: Right grows a pane on its left, Left grows a
 * pane on its right. Other keys pass through unchanged. */
export function keyForSide(key: string, side: "start" | "end"): string {
  if (side === "start") return key;
  if (key === "ArrowRight") return "ArrowLeft";
  if (key === "ArrowLeft") return "ArrowRight";
  return key;
}

/**
 * The width a key press asks for, or null when the key does nothing. The
 * handle sits on the pane's end edge, so Right grows it and Left shrinks it.
 */
export function keyboardWidth(key: string, width: number, limits: PaneLimits, large: boolean): number | null {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  switch (key) {
    case "ArrowRight": return clampWidth(width + step, limits);
    case "ArrowLeft": return clampWidth(width - step, limits);
    case "Home": return limits.min;
    case "End": return limits.max;
    default: return null;
  }
}
