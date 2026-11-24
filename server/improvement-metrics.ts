// Derived metrics for the Improve page and the improvement digest.
//
// Unlike the evidence snapshot, these come from aggregate queries over the
// whole metrics_events table, so the item and event caps never skew them.

import type { Db } from "./db.ts";
import { STOPPED_ESCALATED_METRIC } from "./stopped-retry.ts";
import type { RateCounts, StoppedRunRate } from "../shared/improvement-metrics.ts";

export type { StoppedRunRate } from "../shared/improvement-metrics.ts";

const DAY = 86_400_000;

/** Merge of the automatic stopped-run retry (ADR 0016, corral#218). */
export const STOPPED_RETRY_PIVOT_MS = Date.parse("2026-11-23T15:32:51Z");
export const DEFAULT_METRIC_DAYS = 14;

/** Titles stoppedEscalationContent produces, for rows older than the marker. */
const ESCALATION_TITLE = /(?:^Agent | — )(?:run failed|stopped without reporting|stopped unexpectedly)$/;
/** A marker and the item.created event of one escalation land milliseconds apart. */
const SAME_ESCALATION_MS = 60_000;

interface Escalation { task_id: string; ts: number; item_id: string | null; source: keyof StoppedRunRate["sources"] }
interface Dispatch { ts: number; task_id: string; harness: string }

function counts(dispatches: number, escalations: number): RateCounts {
  return { dispatches, escalations, rate: dispatches > 0 ? escalations / dispatches : null };
}

/** Stopped or failed runs escalated to the inbox, per dispatch and harness,
 *  in the `days` before `pivot` and the `days` after it (cut at now). Each
 *  escalation counts against the latest dispatch of its task before it, so
 *  only escalations of runs dispatched inside a window count there. The
 *  harness is the one the dispatch used, not the task's current target. */
export function stoppedRunRate(db: Db, opts: { now?: number; pivot_ms?: number; days?: number } = {}): StoppedRunRate {
  const now = opts.now ?? Date.now();
  const pivot = opts.pivot_ms ?? STOPPED_RETRY_PIVOT_MS;
  const days = opts.days ?? DEFAULT_METRIC_DAYS;
  const before = { start_ms: pivot - days * DAY, end_ms: pivot };
  const after = { start_ms: pivot, end_ms: Math.max(pivot, Math.min(pivot + days * DAY, now)) };

  const dispatches = (db.raw
    .prepare(
      `SELECT e.ts AS ts, e.ref AS task_id, COALESCE(json_extract(e.data, '$.target'), t.target, 'unknown') AS harness
       FROM metrics_events e LEFT JOIN tasks t ON t.id = e.ref
       WHERE e.name = 'task.dispatched' AND e.ref IS NOT NULL AND e.ts >= ? AND e.ts < ? AND json_valid(COALESCE(e.data, '{}'))
       ORDER BY e.ts ASC`,
    )
    .all(before.start_ms, after.end_ms) as unknown as Dispatch[]);

  const escalations = collectEscalations(db, before.start_ms);

  const byTask = new Map<string, Dispatch[]>();
  for (const d of dispatches) {
    const list = byTask.get(d.task_id);
    if (list) list.push(d);
    else byTask.set(d.task_id, [d]);
  }

  type Tally = { before: [number, number]; after: [number, number] };
  const tally = new Map<string, Tally>();
  const bucket = (harness: string): Tally => {
    let t = tally.get(harness);
    if (!t) tally.set(harness, (t = { before: [0, 0], after: [0, 0] }));
    return t;
  };
  const windowOf = (ts: number): "before" | "after" | null =>
    ts >= before.start_ms && ts < before.end_ms ? "before" : ts >= after.start_ms && ts < after.end_ms ? "after" : null;

  for (const d of dispatches) {
    const w = windowOf(d.ts);
    if (w) bucket(d.harness)[w][0]++;
  }
  const sources = { marker: 0, capture_event: 0, title: 0 };
  for (const e of escalations) {
    const runs = byTask.get(e.task_id);
    let run: Dispatch | null = null;
    for (const d of runs ?? []) if (d.ts <= e.ts) run = d;
    const w = run ? windowOf(run.ts) : null;
    if (!run || !w) continue;
    bucket(run.harness)[w][1]++;
    sources[e.source]++;
  }

  const rows = [...tally.entries()]
    .map(([harness, t]) => ({ harness, before: counts(...t.before), after: counts(...t.after) }))
    .sort((a, b) => b.before.dispatches + b.after.dispatches - (a.before.dispatches + a.after.dispatches) || a.harness.localeCompare(b.harness));
  const sum = (w: "before" | "after", i: 0 | 1) => [...tally.values()].reduce((n, t) => n + t[w][i], 0);
  return {
    pivot_ms: pivot,
    days,
    before,
    after,
    total: { before: counts(sum("before", 0), sum("before", 1)), after: counts(sum("after", 0), sum("after", 1)) },
    by_harness: rows,
    sources,
  };
}

/** Escalations since `since`. The task.stopped_escalated marker counts every
 *  escalation, including a reopened item. Older rows only have the item.created
 *  capture "idle-fallback" event (since corral#126), and before that the title. */
function collectEscalations(db: Db, since: number): Escalation[] {
  const markers = db.raw
    .prepare(
      `SELECT ts, ref AS task_id, json_extract(data, '$.item_id') AS item_id FROM metrics_events
       WHERE name = ? AND ref IS NOT NULL AND ts >= ? AND json_valid(COALESCE(data, '{}'))`,
    )
    .all(STOPPED_ESCALATED_METRIC, since) as unknown as { ts: number; task_id: string; item_id: string | null }[];
  const markedAt = new Map<string, number[]>();
  for (const m of markers) {
    if (!m.item_id) continue;
    const list = markedAt.get(m.item_id);
    if (list) list.push(m.ts);
    else markedAt.set(m.item_id, [m.ts]);
  }
  const marked = (itemId: string, ts: number) => (markedAt.get(itemId) ?? []).some((m) => Math.abs(m - ts) <= SAME_ESCALATION_MS);

  const out: Escalation[] = markers.map((m) => ({ ...m, source: "marker" }));
  const captured = db.raw
    .prepare(
      `SELECT e.ts AS ts, e.ref AS item_id, COALESCE(json_extract(e.data, '$.task_id'), i.task_id) AS task_id
       FROM metrics_events e LEFT JOIN items i ON i.id = e.ref
       WHERE e.name = 'item.created' AND e.ts >= ? AND json_valid(COALESCE(e.data, '{}'))
         AND json_extract(e.data, '$.capture') = 'idle-fallback'`,
    )
    .all(since) as unknown as { ts: number; item_id: string; task_id: string | null }[];
  const capturedIds = new Set<string>();
  for (const c of captured) {
    capturedIds.add(c.item_id);
    if (!c.task_id || marked(c.item_id, c.ts)) continue;
    out.push({ ts: c.ts, task_id: c.task_id, item_id: c.item_id, source: "capture_event" });
  }
  const titled = db.raw
    .prepare("SELECT id, title, task_id, created_ms FROM items WHERE kind = 'question' AND task_id IS NOT NULL AND created_ms >= ?")
    .all(since) as unknown as { id: string; title: string; task_id: string; created_ms: number }[];
  for (const i of titled) {
    if (capturedIds.has(i.id) || markedAt.has(i.id) || !ESCALATION_TITLE.test(i.title)) continue;
    out.push({ ts: i.created_ms, task_id: i.task_id, item_id: i.id, source: "title" });
  }
  return out;
}
