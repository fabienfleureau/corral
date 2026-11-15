import type { Db } from "./db.ts";

const DAY = 86_400_000;
const RETRY = 3_600_000;

/** Allowed automatic-run intervals in days; 0 turns the schedule off. */
export const INTERVAL_DAYS = [0, 1, 7, 30];

export function isInterval(days: unknown): days is number {
  return typeof days === "number" && INTERVAL_DAYS.includes(days);
}

interface Row {
  interval_days: number;
  last_success_ms: number | null;
  last_attempt_ms: number | null;
  error: string | null;
}

/** Persisted schedule of one analysis: interval, last attempt/success and the
 *  last error, in a single-row table so a restart catches up on missed runs. */
export class AnalysisSchedule {
  private db: Db;
  private table: string;

  constructor(db: Db, table: string) {
    // The name is interpolated into SQL: only ever pass a literal from code.
    if (!/^[a-z_]+$/.test(table)) throw new Error("Invalid table name");
    this.db = db;
    this.table = table;
    db.raw.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY CHECK(id = 1), interval_days INTEGER NOT NULL DEFAULT 0, last_success_ms INTEGER, last_attempt_ms INTEGER, error TEXT)`);
    db.raw.exec(`INSERT OR IGNORE INTO ${table} (id) VALUES (1)`);
  }

  status() {
    const row = this.db.raw.prepare(`SELECT * FROM ${this.table} WHERE id = 1`).get() as unknown as Row;
    return { intervalDays: row.interval_days, lastSuccessMs: row.last_success_ms, lastAttemptMs: row.last_attempt_ms, error: row.error };
  }

  setIntervalDays(days: number): void {
    if (!isInterval(days)) throw new Error("Invalid interval");
    this.db.raw.prepare(`UPDATE ${this.table} SET interval_days = ?, last_attempt_ms = NULL WHERE id = 1`).run(days);
  }

  /** A run is due when scheduled, the last success is older than the interval,
   *  and a failed attempt has waited out the retry delay. */
  isDue(now: number): boolean {
    const s = this.status();
    if (!s.intervalDays) return false;
    if (s.lastSuccessMs && now - s.lastSuccessMs < s.intervalDays * DAY) return false;
    if (s.error && s.lastAttemptMs && now - s.lastAttemptMs < RETRY) return false;
    return true;
  }

  begin(now: number): void {
    this.db.raw.prepare(`UPDATE ${this.table} SET last_attempt_ms = ?, error = NULL WHERE id = 1`).run(now);
  }

  succeed(now: number): void {
    this.db.raw.prepare(`UPDATE ${this.table} SET last_success_ms = ?, error = NULL WHERE id = 1`).run(now);
  }

  fail(err: unknown): void {
    this.db.raw.prepare(`UPDATE ${this.table} SET error = ? WHERE id = 1`).run((err instanceof Error ? err.message : String(err)).slice(0, 500));
  }
}
