// Jira status sync: mirror a task's lifecycle onto the ticket it came from.
//
// Only tasks imported from Jira (task.jira_key) are touched, and only
// forwards: dispatching the agent moves the ticket to "In Progress", an open
// PR/MR to "Code Review", a PR that passed the readiness gate to "Ready to
// merge", and a merge to "Done". Status names are workflow-specific, so they
// are configurable (cfg.jira.statuses) with those names as defaults; a blank
// name disables that stage.
//
// Jira can only move an issue through the transitions its workflow offers
// *now*: when the direct transition is unavailable (e.g. Corral missed "Code
// Review" while the server was down), the walker takes the intermediate
// statuses in workflow order instead of failing. Every sync is a no-op once
// the ticket already sits at that stage or beyond — the cached status on the
// task is the dedupe (and the reason a periodic PR sync costs no Jira call).

import type { Db } from "./db.ts";
import type { JiraTransition } from "./jira.ts";
import type { Task } from "./types.ts";

export type JiraStage = "to_do" | "in_progress" | "code_review" | "ready_to_merge" | "done";

/** Workflow order: also the order of the intermediate hops. */
export const JIRA_STAGE_ORDER: JiraStage[] = ["to_do", "in_progress", "code_review", "ready_to_merge", "done"];

const DEFAULT_STATUS_NAMES: Record<JiraStage, string> = {
  to_do: "To Do",
  in_progress: "In Progress",
  code_review: "Code Review",
  ready_to_merge: "Ready to merge",
  done: "Done",
};

/** Case/accents/spacing-insensitive form used to match status names. */
export function normalizeStatus(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

/** Effective status names: configured overrides merged over the defaults.
 *  An empty override disables that stage. */
export function jiraStatusNames(overrides?: Partial<Record<JiraStage, string>> | null): Record<JiraStage, string> {
  const out = { ...DEFAULT_STATUS_NAMES };
  for (const stage of JIRA_STAGE_ORDER) {
    const value = overrides?.[stage];
    if (typeof value === "string") out[stage] = value.trim();
  }
  return out;
}

/** The stage a Jira status name stands for, or null when it is not ours. */
export function stageOfStatus(name: string | null | undefined, names: Record<JiraStage, string>): JiraStage | null {
  if (!name) return null;
  const wanted = normalizeStatus(name);
  return JIRA_STAGE_ORDER.find((stage) => names[stage] && normalizeStatus(names[stage]) === wanted) ?? null;
}

/** The slice of the Jira client the sync needs (fakeable in tests). */
export interface JiraTransitionGateway {
  /** False when Corral has no credentials: every sync is a no-op. */
  readonly configured?: boolean;
  transitions(key: string): Promise<JiraTransition[]>;
  transition(key: string, transitionId: string): Promise<void>;
}

export interface AdvanceResult {
  /** Status name the issue started from (cached value; null when unknown). */
  from: string | null;
  to: string;
  /** Status names actually entered, in order. */
  path: string[];
}

function matchTransition(list: JiraTransition[], name: string): JiraTransition | null {
  const wanted = normalizeStatus(name);
  return (
    list.find((t) => t.to?.name && normalizeStatus(t.to.name) === wanted) ??
    list.find((t) => normalizeStatus(t.name) === wanted) ??
    null
  );
}

/**
 * Move an issue to `target`, taking intermediate steps from `chain` (status
 * names in workflow order) when the direct transition is not offered.
 * Throws when the target is unreachable; the error carries the partial path.
 */
export async function advanceJiraStatus(
  gateway: JiraTransitionGateway,
  key: string,
  target: string,
  opts: { from?: string | null; chain?: string[] } = {},
): Promise<AdvanceResult> {
  const chain = (opts.chain ?? []).map((n) => n.trim()).filter(Boolean);
  const wanted = normalizeStatus(target);
  const start = opts.from ? chain.findIndex((n) => normalizeStatus(n) === normalizeStatus(opts.from!)) : -1;
  const path: string[] = [];
  let position = start;

  for (let hop = 0; hop < chain.length + 1; hop++) {
    const list = await gateway.transitions(key);
    const direct = matchTransition(list, target);
    if (direct) {
      await gateway.transition(key, direct.id);
      path.push(direct.to?.name ?? target);
      return { from: opts.from ?? null, to: target, path };
    }
    // Intermediate: the first later workflow status this issue can enter.
    // Candidates before the cached status are skipped so a sync never walks
    // the ticket backwards.
    let next: { index: number; transition: JiraTransition } | null = null;
    for (let i = position + 1; i < chain.length; i++) {
      if (normalizeStatus(chain[i]) === wanted) continue;
      const transition = matchTransition(list, chain[i]);
      if (transition) {
        next = { index: i, transition };
        break;
      }
    }
    if (!next) break;
    await gateway.transition(key, next.transition.id);
    path.push(next.transition.to?.name ?? chain[next.index]);
    position = next.index;
  }

  const available = await gateway.transitions(key).catch(() => []);
  const err = new Error(
    `Jira ${key}: cannot reach "${target}"` +
      (available.length ? ` — available: ${available.map((t) => `${t.id}=${t.to?.name ?? t.name}`).join(", ")}` : ""),
  ) as Error & { path?: string[] };
  err.path = path;
  throw err;
}

export interface JiraSyncDeps {
  db: Db;
  hub?: { broadcast: (type: string, data: unknown) => void } | null;
  gateway: JiraTransitionGateway;
  /** cfg.jira.statuses — workflow-specific names. */
  statuses?: Partial<Record<JiraStage, string>> | null;
}

export interface JiraSyncResult {
  stage: JiraStage;
  /** Jira status name the stage maps to ("" when the stage is disabled). */
  status: string;
  applied: boolean;
  /** Machine-readable why it did or did not move. */
  reason: string;
  /** Status names entered, in order (empty when nothing moved). */
  path: string[];
}

/** Per-ticket serialization: two syncs must not race on the same workflow. */
const inFlight = new Map<string, Promise<unknown>>();

/** Mirror one lifecycle stage onto the task's Jira ticket. Never throws:
 *  a Jira outage must not break a dispatch or a PR sync. */
export function syncJiraStage(deps: JiraSyncDeps, task: Task, stage: JiraStage): Promise<JiraSyncResult> {
  const key = task.jira_key ?? task.id;
  const previous = inFlight.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => applyStage(deps, task, stage));
  inFlight.set(key, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (inFlight.get(key) === next) inFlight.delete(key);
    });
  return next;
}

async function applyStage(deps: JiraSyncDeps, staleTask: Task, stage: JiraStage): Promise<JiraSyncResult> {
  const names = jiraStatusNames(deps.statuses);
  const status = names[stage];
  const result: JiraSyncResult = { stage, status, applied: false, reason: "", path: [] };
  const task = deps.db.getTask(staleTask.id) ?? staleTask;

  if (!task.jira_key) {
    result.reason = "no jira ticket";
    return result;
  }
  if (!status) {
    result.reason = `stage ${stage} is disabled`;
    return result;
  }
  if (deps.gateway.configured === false) {
    result.reason = "jira not configured";
    return result;
  }
  const cached = task.jira_status ?? null;
  const cachedStage = stageOfStatus(cached, names);
  if (cachedStage && JIRA_STAGE_ORDER.indexOf(cachedStage) >= JIRA_STAGE_ORDER.indexOf(stage)) {
    result.reason = `already at ${cached}`;
    return result;
  }

  const chain = JIRA_STAGE_ORDER.map((s) => names[s]).filter(Boolean);
  try {
    const moved = await advanceJiraStatus(deps.gateway, task.jira_key, status, { from: cached, chain });
    const reached = moved.path.at(-1) ?? status;
    result.applied = true;
    result.path = moved.path;
    result.reason = `moved to ${reached}`;
    deps.db.updateTask(task.id, { jira_status: reached });
    deps.db.recordMetric("jira.status_synced", task.id, {
      key: task.jira_key,
      stage,
      from: cached,
      to: reached,
      path: moved.path,
    });
    deps.hub?.broadcast("task.updated", deps.db.getTask(task.id));
  } catch (err) {
    // Partial progress (intermediate hops) is real: cache it so the next sync
    // resumes from there instead of replaying the whole chain.
    const path = (err as Error & { path?: string[] }).path ?? [];
    if (path.length > 0) {
      result.path = path;
      deps.db.updateTask(task.id, { jira_status: path[path.length - 1] });
    }
    result.reason = err instanceof Error ? err.message : String(err);
    deps.db.recordMetric("jira.status_failed", task.id, {
      key: task.jira_key,
      stage,
      error: result.reason.slice(0, 300),
      path,
    });
  }
  return result;
}
