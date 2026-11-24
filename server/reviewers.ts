/** Named reviews a code task runs on its diff before opening the PR/MR. A
 *  reviewer is either a shell command the agent runs, or a delegate: a
 *  sub-agent on another harness that the agent hands the review to, so the
 *  review is paid from that harness's quota. */

export const DELEGATE_HARNESSES = ["claude", "codex"] as const;
export type DelegateHarness = (typeof DELEGATE_HARNESSES)[number];

export type CommandReviewer = { name: string; command: string };
export type DelegateReviewer = { name: string; delegate: DelegateHarness };
export type Reviewer = CommandReviewer | DelegateReviewer;

export function isDelegateReviewer(r: Reviewer): r is DelegateReviewer {
  return "delegate" in r;
}

/** The sub-agent name a delegate reviewer is called by (a valid omnigent agent name). */
export function delegateAgentName(r: DelegateReviewer): string {
  return `ocr_${r.delegate}`;
}

/** What a task shows as its review: the command (as written, before `{base_branch}`
 *  is resolved), or the sub-agent the review is handed to. */
export function reviewSummary(r: Reviewer): string {
  return isDelegateReviewer(r) ? `sub-agent ${delegateAgentName(r)}` : r.command;
}

/** Find a configured reviewer by its name or frozen task summary. */
export function reviewerBySummary(review: string | null | undefined, reviewers: Reviewer[]): Reviewer | null {
  const trimmed = review?.trim() ?? "";
  if (!trimmed) return null;
  return reviewers.find((r) => r.name === trimmed || reviewSummary(r) === trimmed) ?? null;
}

/**
 * Why `reviewer` cannot run with this dispatch, or null when it can. A delegate
 * needs an agent that can call sub-agents: Corral picks one, which only works
 * on the Claude harness (the one that was tried) and never over an explicit
 * agent, because agents stay an explicit opt-in.
 */
export function delegateConflict(reviewer: Reviewer, target: string, agent: string | null | undefined): string | null {
  if (!isDelegateReviewer(reviewer)) return null;
  if (target !== "claude") return `reviewer ${reviewer.name} delegates the review, which needs the claude harness (got ${target})`;
  if (agent) return `reviewer ${reviewer.name} delegates the review, which cannot run on an explicit agent`;
  return null;
}

export function parseReviewers(value: unknown): Reviewer[] {
  if (!Array.isArray(value)) throw new Error("Reviewers must be an array");
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid reviewer");
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name.trim()) throw new Error("Each reviewer needs a name");
    const name = r.name.trim();
    if (seen.has(name)) throw new Error(`Duplicate reviewer name: ${name}`);
    seen.add(name);

    const command = typeof r.command === "string" ? r.command.trim() : "";
    if (r.command !== undefined && typeof r.command !== "string") throw new Error("A reviewer command must be a string");
    if (r.delegate === undefined || r.delegate === "") {
      if (!command) throw new Error("Each reviewer needs a command or a delegate");
      return { name, command };
    }
    // An empty command next to a delegate is what a form with a hidden field sends.
    if (command) throw new Error(`Reviewer ${name} has both a command and a delegate`);
    if (!(DELEGATE_HARNESSES as readonly unknown[]).includes(r.delegate)) {
      throw new Error(`Unknown delegate harness: ${String(r.delegate)}`);
    }
    return { name, delegate: r.delegate as DelegateHarness };
  });
}
