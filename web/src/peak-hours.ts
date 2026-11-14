// Peak-hour pricing: OpenCode bills DeepSeek models at twice the rate during
// fixed UTC windows, Monday to Friday. Pure functions of a clock reading; the
// UI passes `now` in so a favorite can turn red while the window is open.

/** Half-open UTC hour ranges [startHour, endHour) when the rate doubles. */
export const PEAK_WINDOWS: readonly { startHour: number; endHour: number }[] = [
  { startHour: 1, endHour: 4 },
  { startHour: 6, endHour: 10 },
];

/** Monday..Friday in UTC (Date#getUTCDay: Sunday is 0). */
const isPeakDay = (day: number): boolean => day >= 1 && day <= 5;

/** True for an OpenCode DeepSeek model id ("opencode-go/deepseek-v4.1-flash"). */
export function hasPeakPricing(harness: string, model: string): boolean {
  return harness === "opencode" && /deepseek/i.test(model);
}

/** The window open at `now`, or null off-peak. */
function openWindow(now: Date): { startHour: number; endHour: number } | null {
  if (!isPeakDay(now.getUTCDay())) return null;
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  return PEAK_WINDOWS.find((w) => hour >= w.startHour && hour < w.endHour) ?? null;
}

export function isPeakNow(now: Date): boolean {
  return openWindow(now) !== null;
}

const hhmm = (hour: number): string => `${String(hour).padStart(2, "0")}:00 UTC`;

/** "04:00 UTC" while a window is open, null off-peak. */
export function peakEndsLabel(now: Date): string | null {
  const window = openWindow(now);
  return window ? hhmm(window.endHour) : null;
}

/** "01:00–04:00 and 06:00–10:00 UTC, Mon–Fri" — the schedule, for tooltips. */
export const PEAK_SCHEDULE_LABEL = `${PEAK_WINDOWS.map((w) => `${hhmm(w.startHour).slice(0, 5)}–${hhmm(w.endHour).slice(0, 5)}`).join(" and ")} UTC, Mon–Fri`;
