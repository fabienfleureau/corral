// Automatic retry policy for dispatched tasks whose agent session stopped
// without reporting (ADR 0016).
//
// - Fatal errors (auth, billing/quota, invalid model, context limit) escalate
//   to the inbox immediately (0 retries).
// - Transient errors and mid-run crashes (including `lastRunOutcome === null`
//   and `done` / `error` statuses) retry up to `maxAttempts` times with
//   backoff (`delaysSec`), then escalate to the inbox.
// - Silent stops (assistant message without calling `/api/reports`) get up to
//   `silentStopAttempts` short nudge(s) before escalating to the inbox.

import { oneLine } from "./task-events.ts";
import type { WorkerRunOutcome } from "./worker.ts";

export interface StoppedRetryConfig {
  /** Max automatic retries for transient errors and mid-run crashes. */
  maxAttempts: number;
  /** Backoff delays in seconds between retries. Last entry repeats if needed. */
  delaysSec: number[];
  /** Max automatic nudges when an agent stops with a closing message but no report. */
  silentStopAttempts: number;
}

export const DEFAULT_STOPPED_RETRY: StoppedRetryConfig = {
  maxAttempts: 2,
  delaysSec: [15, 60],
  silentStopAttempts: 1,
};

/** Session statuses that mean the agent is no longer actively running. */
export const STOPPED_STATUSES = new Set(["idle", "done", "error"]);

export type StoppedCategory = "fatal" | "error" | "silent";

function clampInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

export function resolveStoppedRetryConfig(raw?: Partial<StoppedRetryConfig> | null): StoppedRetryConfig {
  const maxAttempts = clampInt(raw?.maxAttempts, DEFAULT_STOPPED_RETRY.maxAttempts, 10);
  const silentStopAttempts = clampInt(raw?.silentStopAttempts, DEFAULT_STOPPED_RETRY.silentStopAttempts, 5);
  const delaysSec = Array.isArray(raw?.delaysSec) && raw.delaysSec.length > 0
    ? raw.delaysSec
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0)
      .map((n) => Math.min(3600, n))
    : [];
  return {
    maxAttempts,
    delaysSec: delaysSec.length > 0 ? delaysSec : [...DEFAULT_STOPPED_RETRY.delaysSec],
    silentStopAttempts,
  };
}

const FATAL_ERROR_PATTERNS: RegExp[] = [
  /\b(?:status|http|error)\s*:?\s*(?:401|402|403)\b/i,
  /\b(?:401|402|403)\s*:/,
  /\b(?:unauthorized|forbidden|payment\s+required)\b/i,
  /\b(?:invalid[ _-]?api[ _-]?key|authentication[ _-]?(?:error|failed)|auth[ _-]?failed)\b/i,
  /\b(?:insufficient[ _-]?(?:balance|credits|funds|quota)|credit\s+balance|billing\s+(?:error|limit|disabled)|quota\s+exceeded)\b/i,
  /\b(?:model[ _-]?not[ _-]?found|unknown\s+model|invalid\s+model)\b/i,
  /\b(?:context[ _-]?(?:length|window)[ _-]?exceeded|maximum\s+context\s+length)\b/i,
];

/** True when retrying the same session cannot fix the failure (auth, billing,
 *  unsupported model, exhausted context). */
export function isFatalStopError(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return FATAL_ERROR_PATTERNS.some((re) => re.test(trimmed));
}

export function classifyStoppedRun(
  status: string | null,
  outcome: WorkerRunOutcome | null,
  opts: { initialRetryExhausted?: boolean } = {},
): StoppedCategory {
  if (outcome?.kind === "error") {
    if (opts.initialRetryExhausted && outcome.text.trim() === "native_terminal_start_failed") {
      return "fatal";
    }
    if (isFatalStopError(outcome.text)) return "fatal";
    return "error";
  }
  if (status === "error") return "error";
  if (outcome?.kind === "message") return "silent";
  return "error";
}

export function stoppedRetryBudget(policy: StoppedRetryConfig, category: StoppedCategory): number {
  if (category === "fatal") return 0;
  return category === "silent" ? policy.silentStopAttempts : policy.maxAttempts;
}

export function stoppedRetryDelayMs(
  policy: StoppedRetryConfig,
  category: "error" | "silent",
  attemptIndex: number,
): number {
  const idx = category === "silent" ? 0 : Math.min(Math.max(0, attemptIndex), policy.delaysSec.length - 1);
  const sec = policy.delaysSec[idx] ?? DEFAULT_STOPPED_RETRY.delaysSec[0];
  return Math.max(0, Math.round(sec * 1000));
}

/** Prompt sent to a stopped session on automatic retry/nudge. Registered in docs/prompts.md. */
export function stoppedRetryPrompt(
  category: "error" | "silent",
  outcome: WorkerRunOutcome | null,
  attempt: number,
  maxAttempts: number,
): string {
  if (category === "silent") {
    return `You stopped without reporting to the Corral inbox (automatic nudge ${attempt}/${maxAttempts}). If the task is still in progress, continue it. If you need input from the human, report a question via POST /api/reports; if the work is complete, finish the handoff steps and report done.`;
  }
  const detail = outcome?.text ? ` (${oneLine(outcome.text, 200)})` : "";
  return `Your previous turn stopped unexpectedly${detail} (automatic retry ${attempt}/${maxAttempts}). Check the current workspace state and continue the task. If you are blocked on a decision or missing prerequisite, report a question to the Corral inbox; when finished, commit, push, open the PR/MR if applicable, and report done.`;
}

export function stoppedEscalationContent(opts: {
  label: string | undefined;
  status: string | null;
  outcome: WorkerRunOutcome | null;
  category: StoppedCategory;
  attemptsUsed: number;
  maxTextLen: number;
  sendError?: string | null;
}): { title: string; body: string } {
  const { label, outcome, category, attemptsUsed, maxTextLen, sendError } = opts;
  const rawText = outcome?.text ?? "";
  const text = rawText.length > maxTextLen ? `${rawText.slice(0, maxTextLen)}…` : rawText;
  const retrySuffix = attemptsUsed > 0
    ? category === "silent"
      ? ` after ${attemptsUsed} automatic ${attemptsUsed === 1 ? "nudge" : "nudges"}`
      : ` after ${attemptsUsed} automatic ${attemptsUsed === 1 ? "retry" : "retries"}`
    : "";
  const sendNote = sendError ? `\n\nAutomatic retry could not be delivered: ${oneLine(sendError, 300)}` : "";

  if (outcome?.kind === "error" || opts.status === "error") {
    const title = label ? `${label} — run failed` : "Agent run failed";
    const lead = `**The run failed${retrySuffix}.** Fix the cause, then reply to resume it, or mark the task done.`;
    const body = text ? `${lead}${sendNote}\n\n${text}` : `${lead}${sendNote}`;
    return { title, body };
  }
  if (outcome?.kind === "message") {
    const title = label ? `${label} — stopped without reporting` : "Agent stopped without reporting";
    const lead = `**The agent stopped without reporting${retrySuffix}.** Reply to continue it, or mark the task done.`;
    return { title, body: `${lead}${sendNote}\n\n${text}` };
  }
  const title = label ? `${label} — stopped unexpectedly` : "Agent stopped unexpectedly";
  const lead = `**The agent stopped unexpectedly without reporting${retrySuffix}.** Reply to continue it, or mark the task done.`;
  return { title, body: `${lead}${sendNote}` };
}
