// Reviewers in the UI: a command the agent runs, or a delegate sub-agent. The
// rule about where a delegate can run mirrors `delegateConflict` in
// server/reviewers.ts; the server enforces it, this only keeps the pickers honest.

import type { DelegateHarness, Reviewer } from "./types.ts";

export type ReviewerKind = "command" | DelegateHarness;
export type ReviewerDraft = { name: string; kind: ReviewerKind; command: string };

export const EMPTY_REVIEWER_DRAFT: ReviewerDraft = { name: "", kind: "command", command: "" };

export const REVIEWER_KINDS: { kind: ReviewerKind; label: string }[] = [
  { kind: "command", label: "A command" },
  { kind: "claude", label: "A Claude sub-agent" },
  { kind: "codex", label: "A Codex sub-agent" },
];

export function isDelegate(r: Reviewer): r is { name: string; delegate: DelegateHarness } {
  return "delegate" in r;
}

export function reviewerToDraft(r: Reviewer): ReviewerDraft {
  return isDelegate(r) ? { name: r.name, kind: r.delegate, command: "" } : { name: r.name, kind: "command", command: r.command };
}

/** The reviewer a draft describes, or null while it is incomplete. */
export function draftToReviewer(d: ReviewerDraft): Reviewer | null {
  const name = d.name.trim();
  if (!name) return null;
  if (d.kind !== "command") return { name, delegate: d.kind };
  const command = d.command.trim();
  return command ? { name, command } : null;
}

export function reviewerSummary(r: Reviewer): string {
  return isDelegate(r) ? `Hands the review to a ${r.delegate === "claude" ? "Claude" : "Codex"} sub-agent` : r.command;
}

/** Match a saved task review string (name or frozen summary) back to a configured reviewer. */
export function reviewerBySummary(review: string | null | undefined, reviewers: Reviewer[]): Reviewer | null {
  const trimmed = review?.trim() ?? "";
  if (!trimmed) return null;
  return reviewers.find((r) => {
    if (r.name === trimmed) return true;
    const frozen = isDelegate(r) ? `sub-agent ocr_${r.delegate}` : r.command;
    return frozen === trimmed;
  }) ?? null;
}

/** A delegate review needs the Claude harness and no explicit agent. */
export function reviewerBlocked(r: Reviewer, harness: string, agent: string): boolean {
  return isDelegate(r) && (harness !== "claude" || agent !== "");
}

/** The picker label: a blocked delegate says what it needs. */
export function reviewerOptionLabel(r: Reviewer, harness: string, agent: string): string {
  return reviewerBlocked(r, harness, agent) ? `${r.name} (needs Claude, no agent)` : r.name;
}
