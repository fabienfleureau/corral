import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPeakPricing, isPeakNow, peakEndsLabel, PEAK_SCHEDULE_LABEL } from "../../web/src/peak-hours.ts";
import { modelFactsReport } from "../../web/src/model-indicators.ts";

// 2026-11-16 is a Monday, 2026-11-14 a Saturday (UTC).
const at = (day: string, time: string) => new Date(`2026-11-${day}T${time}:00Z`);

test("both weekday windows are peak, with the start inclusive and the end exclusive", () => {
  assert.equal(isPeakNow(at("16", "00:59")), false);
  assert.equal(isPeakNow(at("16", "01:00")), true);
  assert.equal(isPeakNow(at("16", "03:59")), true);
  assert.equal(isPeakNow(at("16", "04:00")), false);
  assert.equal(isPeakNow(at("16", "05:59")), false);
  assert.equal(isPeakNow(at("16", "06:00")), true);
  assert.equal(isPeakNow(at("16", "09:59")), true);
  assert.equal(isPeakNow(at("16", "10:00")), false);
  assert.equal(isPeakNow(at("16", "23:00")), false);
});

test("Friday is peak, Saturday and Sunday are not", () => {
  assert.equal(isPeakNow(at("20", "02:00")), true);
  assert.equal(isPeakNow(at("14", "02:00")), false);
  assert.equal(isPeakNow(at("15", "07:00")), false);
});

test("the window is read in UTC, not in the local zone", () => {
  // Sunday 18:00 at UTC-8 is Monday 02:00 UTC: peak.
  assert.equal(isPeakNow(new Date("2026-11-15T18:00:00-08:00")), true);
  // Monday 01:30 at UTC+1 is Monday 00:30 UTC: not yet peak.
  assert.equal(isPeakNow(new Date("2026-11-16T01:30:00+01:00")), false);
  // Friday 20:00 at UTC-8 is Saturday 04:00 UTC: weekend.
  assert.equal(isPeakNow(new Date("2026-11-20T20:00:00-08:00")), false);
});

test("the end label names the window that is open, null off-peak", () => {
  assert.equal(peakEndsLabel(at("16", "02:00")), "04:00 UTC");
  assert.equal(peakEndsLabel(at("16", "08:30")), "10:00 UTC");
  assert.equal(peakEndsLabel(at("16", "05:00")), null);
  assert.equal(PEAK_SCHEDULE_LABEL, "01:00–04:00 and 06:00–10:00 UTC, Mon–Fri");
});

test("only OpenCode DeepSeek models have peak pricing", () => {
  assert.equal(hasPeakPricing("opencode", "opencode-go/deepseek-v4.1-flash"), true);
  assert.equal(hasPeakPricing("opencode", "deepseek/deepseek-chat"), true);
  assert.equal(hasPeakPricing("opencode", "opencode-go/kimi-k3.1-pro"), false);
  assert.equal(hasPeakPricing("opencode", ""), false);
  assert.equal(hasPeakPricing("claude", "opencode-go/deepseek-v4.1-flash"), false);
});

const deepseek = "opencode-go/deepseek-v4.1-flash";
const report = (now: Date, model = deepseek, harness = "opencode") =>
  modelFactsReport({
    selection: { harness, model, reasoning: "" },
    catalog: {},
    harnesses: [{ harness, models: [{ id: model }] }],
    context: "personal",
    now,
  });

test("a DeepSeek choice is flagged during peak hours and says when it ends", () => {
  const peak = report(at("16", "02:00"));
  assert.deepEqual(peak.peak, { until: "04:00 UTC" });
  const pricing = peak.indicators.find((row) => row.key === "pricing");
  assert.equal(pricing?.value, "2× (peak hours)");
  assert.match(peak.title, /Pricing: 2× \(peak hours\)/);
});

test("off-peak a DeepSeek choice is not flagged but still lists the schedule", () => {
  const offPeak = report(at("16", "05:00"));
  assert.equal(offPeak.peak, null);
  const pricing = offPeak.indicators.find((row) => row.key === "pricing");
  assert.equal(pricing?.value, "standard rate");
  assert.match(pricing?.hint ?? "", /01:00–04:00 and 06:00–10:00 UTC, Mon–Fri/);
});

test("other models never carry a pricing row", () => {
  const other = report(at("16", "02:00"), "opencode-go/kimi-k3.1-pro");
  assert.equal(other.peak, null);
  assert.equal(other.indicators.some((row) => row.key === "pricing"), false);
});
