// Evidence for the engineering improvement digest.
//
// The first activity review could only see 50 recent tasks, item metadata and a
// capped event stream: costs, checks, thread state and every item's task were
// missing. This collector joins the item/task/event tables, keeps tasks that
// items or events point at even when they fall outside the recent window, and
// reads the PR snapshots the PR loop now persists. It stays bounded and marks
// what it truncated; production outcomes are still not recorded.

import type { Db } from "./db.ts";
import { taskLabel, type Item, type Task } from "./types.ts";
import type { PrSnapshot } from "./pr.ts";
import type { UsageEvidence } from "./usage.ts";
import { isPublishQuestion } from "./review-outcome.ts";

const DAY = 86_400_000;

const LIFECYCLE_EVENTS = [
  "task.created",
  "task.dispatched",
  "task.finished",
  "task.done",
  "task.archived",
  "task.pr_found",
  "task.initial_retry",
  "task.stopped_retry",
  "task.worktree_removed",
  "item.created",
  "item.replied",
  "item.resolved",
  "item.ready_for_review",
  "item.structured_report",
  "item.snoozed",
  "pr.comments_pushed",
  "pr.conflicts_pushed",
  "jira.imported",
  "jira.marked_done",
  "jira.commented",
  "jira.status_synced",
  "jira.status_failed",
];

const ITEM_EVENTS = ["item.created", "item.replied", "item.resolved", "item.ready_for_review", "item.structured_report", "item.snoozed"];

interface EventRow {
  ts: number;
  name: string;
  ref: string | null;
  data: string | null;
}

interface AggregateRow {
  ref: string;
  name: string;
  count: number;
  first_ms: number;
  last_ms: number;
}

export interface EvidenceTask {
  id: string;
  label: string;
  title: string;
  status: string;
  kind: string;
  target: string;
  agent: string | null;
  model: string | null;
  reasoning: string | null;
  pr_url: string | null;
  pr_role: "authored" | "reviewed";
  /** Review tasks: published / skipped once known, else null. */
  review_outcome: string | null;
  branch: string | null;
  base_branch: string | null;
  repo_path: string;
  jira_key: string | null;
  jira_parent_key: string | null;
  jira_status: string | null;
  created_ms: number;
  updated_ms: number;
  dispatches: { count: number; at_ms: number[]; gaps_ms: number[] };
  items_in_window: { total: number; open: number; question_open: number; pr_open: number; resolved: number; archived: number };
  pr: PrSnapshot | null;
  usage: { cost_usd: number; tokens: number; models: string[]; agents: string[]; unpriced_calls: number } | null;
  flags: string[];
}

export interface EvidenceItem {
  id: string;
  kind: string;
  status: string;
  title: string;
  task_id: string | null;
  task: { id: string; label: string; status: string; kind: string; in_task_window: boolean } | null;
  created_ms: number;
  updated_ms: number;
  resolved_ms: number | null;
  waited_ms: number | null;
  first_reply_ms: number | null;
  events: Record<string, { count: number; first_ms: number; last_ms: number }>;
  flags: string[];
}

export interface EvidenceEvent {
  ts: number;
  name: string;
  ref: string | null;
  data: unknown;
}

export interface ImprovementEvidence {
  window: { since_ms: number; generated_ms: number; days: number };
  limits: { days: number; tasks: number; linked_tasks: number; items: number; events: number };
  truncated: { tasks: boolean; linked_tasks: boolean; items: boolean; events: boolean };
  gaps: string[];
  tasks: EvidenceTask[];
  items: EvidenceItem[];
  events: EvidenceEvent[];
  data_quality: {
    untitled_tasks: string[];
    tasks_without_model: string[];
    done_without_pr: string[];
    review_tasks_with_pr_url: string[];
    repeated_dispatches: { task_id: string; count: number; gaps_ms: number[] }[];
    orphan_items: { item_id: string; task_id: string }[];
    malformed_task_ids: { item_id: string; task_id: string }[];
    resolved_without_timestamp: { item_id: string; resolved_event_ms: number }[];
    archived_without_resolution: string[];
    multiple_resolution_events: { item_id: string; count: number; first_ms: number; last_ms: number }[];
    duplicate_pr_items: { task_id: string; item_ids: string[] }[];
    open_pr_items: { item_id: string; task_id: string | null; age_ms: number }[];
    /** "Publish N review comments?" questions closed with no reply: the drafts were never approved. */
    unpublished_reviews: { count: number; items: { item_id: string; task_id: string | null; status: string }[] };
    items_outside_task_window: number;
  };
  usage: UsageEvidence | null;
}

export interface ImprovementEvidenceOptions {
  now?: number;
  days?: number;
  taskLimit?: number;
  linkedTaskLimit?: number;
  itemLimit?: number;
  eventLimit?: number;
  usage?: UsageEvidence | null;
}

const EVENT_DATA_CHARS = 400;

/** Event payloads are the useful part (dispatch model/address, done reason),
 *  but some carry long text. Keep small payloads intact and clip the rest. */
function parseData(raw: string | null): unknown {
  if (raw === null) return null;
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    /* keep the raw string */
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= EVENT_DATA_CHARS) return value;
  return { truncated: text.slice(0, EVENT_DATA_CHARS), original_chars: text.length };
}

function readPrSnapshot(raw: string | null): PrSnapshot | null {
  try {
    const meta = JSON.parse(raw ?? "{}") as { pr?: unknown };
    return meta.pr && typeof meta.pr === "object" ? (meta.pr as PrSnapshot) : null;
  } catch {
    return null;
  }
}

function inClause(values: string[]): { sql: string; args: string[] } {
  return { sql: values.map(() => "?").join(", "), args: values };
}

export function collectImprovementEvidence(db: Db, opts: ImprovementEvidenceOptions = {}): ImprovementEvidence {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 30;
  const taskLimit = opts.taskLimit ?? 60;
  const linkedTaskLimit = opts.linkedTaskLimit ?? 120;
  const itemLimit = opts.itemLimit ?? 250;
  const eventLimit = opts.eventLimit ?? 800;
  const since = now - days * DAY;

  const count = (sql: string, ...args: (string | number)[]): number =>
    (db.raw.prepare(sql).get(...args) as { n: number }).n;

  // Tasks recently touched, plus every task an item or task event points at.
  const taskCount = count("SELECT COUNT(*) AS n FROM tasks WHERE updated_ms >= ?", since);
  const recentTasks = db.raw
    .prepare("SELECT * FROM tasks WHERE updated_ms >= ? ORDER BY updated_ms DESC LIMIT ?")
    .all(since, taskLimit) as unknown as Task[];

  const itemCount = count("SELECT COUNT(*) AS n FROM items WHERE created_ms >= ? OR status = 'open'", since);
  const itemRows = db.raw
    .prepare("SELECT * FROM items WHERE created_ms >= ? OR status = 'open' ORDER BY created_ms DESC LIMIT ?")
    .all(since, itemLimit) as unknown as Item[];

  const taskEventRefs = db.raw
    .prepare("SELECT DISTINCT ref FROM metrics_events WHERE ts >= ? AND name LIKE 'task.%' AND ref IS NOT NULL")
    .all(since) as { ref: string }[];
  const recentIds = new Set(recentTasks.map((t) => t.id));
  const candidateLinkedIds = [...new Set([
    ...itemRows.map((i) => i.task_id).filter((id): id is string => typeof id === "string" && id.trim() !== "" && !recentIds.has(id)),
    ...taskEventRefs.map((r) => r.ref).filter((id) => !recentIds.has(id)),
  ])];
  const linkedIds = candidateLinkedIds.slice(0, linkedTaskLimit);
  const linkedTasks = linkedIds.length
    ? (db.raw.prepare(`SELECT * FROM tasks WHERE id IN (${inClause(linkedIds).sql})`).all(...linkedIds) as unknown as Task[])
    : [];
  // Tasks beyond the linked cap still exist; do not confuse them with orphan
  // items whose task row is genuinely missing.
  const unloadedExisting = new Set<string>();
  const unloadedIds = candidateLinkedIds.slice(linkedIds.length);
  for (let i = 0; i < unloadedIds.length; i += 400) {
    const chunk = unloadedIds.slice(i, i + 400);
    const rows = db.raw.prepare(`SELECT id FROM tasks WHERE id IN (${inClause(chunk).sql})`).all(...chunk) as { id: string }[];
    for (const row of rows) unloadedExisting.add(row.id);
  }
  const tasks = [...recentTasks, ...linkedTasks];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const inTaskWindow = new Set(recentTasks.map((t) => t.id));

  // Aggregate counts do not depend on the event cap.
  const aggregates = db.raw
    .prepare("SELECT ref, name, COUNT(*) AS count, MIN(ts) AS first_ms, MAX(ts) AS last_ms FROM metrics_events WHERE ts >= ? AND ref IS NOT NULL GROUP BY ref, name")
    .all(since) as unknown as AggregateRow[];
  const aggByRef = new Map<string, Map<string, AggregateRow>>();
  for (const row of aggregates) {
    let byName = aggByRef.get(row.ref);
    if (!byName) aggByRef.set(row.ref, (byName = new Map()));
    byName.set(row.name, row);
  }

  // Scoped events first: everything tied to a task or item we are describing.
  const scopedRefs = [...new Set([...taskById.keys(), ...itemRows.map((i) => i.id)])];
  const scope = inClause(scopedRefs);
  const scopedEvents = scopedRefs.length
    ? (db.raw
        .prepare(`SELECT ts, name, ref, data FROM metrics_events WHERE ts >= ? AND ref IN (${scope.sql}) ORDER BY ts ASC LIMIT ?`)
        .all(since, ...scope.args, eventLimit) as unknown as EventRow[])
    : [];
  const otherNames = inClause(LIFECYCLE_EVENTS);
  const remaining = Math.max(0, eventLimit - scopedEvents.length);
  const notScoped = scopedRefs.length ? `AND (ref IS NULL OR ref NOT IN (${scope.sql}))` : "";
  const otherEvents = remaining
    ? (db.raw
        .prepare(`SELECT ts, name, ref, data FROM metrics_events WHERE ts >= ? AND name IN (${otherNames.sql}) ${notScoped} ORDER BY ts DESC LIMIT ?`)
        .all(since, ...otherNames.args, ...scope.args, remaining) as unknown as EventRow[])
    : [];
  const scopedCount = scopedRefs.length ? ` OR ref IN (${scope.sql})` : "";
  const lifecycleCount = count(
    `SELECT COUNT(*) AS n FROM metrics_events WHERE ts >= ? AND (name IN (${otherNames.sql})${scopedCount})`,
    since,
    ...otherNames.args,
    ...scope.args,
  );
  const eventRows = [...scopedEvents, ...otherEvents].sort((a, b) => a.ts - b.ts);

  // Per-task aggregates.
  const itemByTask = new Map<string, Item[]>();
  for (const item of itemRows) {
    if (!item.task_id) continue;
    const list = itemByTask.get(item.task_id);
    if (list) list.push(item);
    else itemByTask.set(item.task_id, [item]);
  }
  const usageByTask = new Map((opts.usage?.by_task ?? []).map((u) => [u.id, u]));

  const evidenceTasks: EvidenceTask[] = tasks.map((task) => {
    const agg = aggByRef.get(task.id);
    const dispatchAgg = agg?.get("task.dispatched");
    const dispatchAt = eventRows
      .filter((e) => e.name === "task.dispatched" && e.ref === task.id)
      .map((e) => e.ts);
    const gaps: number[] = [];
    for (let i = 1; i < dispatchAt.length; i++) gaps.push(dispatchAt[i] - dispatchAt[i - 1]);
    const taskItems = itemByTask.get(task.id) ?? [];
    const flags: string[] = [];
    if (!task.title.trim()) flags.push("untitled");
    if (!task.model) flags.push("no_pinned_model");
    if (task.status === "done" && task.kind !== "review" && task.kind !== "spec" && !task.pr_url) flags.push("done_without_pr");
    if (task.kind === "review" && task.pr_url) flags.push("review_task_stores_reviewed_pr");
    if ((dispatchAgg?.count ?? 0) > 1) flags.push("dispatched_multiple_times");
    if (task.pr_url && !readPrSnapshot(task.pr_meta)) flags.push("no_pr_snapshot");
    const usage = usageByTask.get(task.id);
    return {
      id: task.id,
      label: taskLabel(task),
      title: task.title,
      status: task.status,
      kind: task.kind ?? "code",
      target: task.target,
      agent: task.agent ?? null,
      model: task.model ?? null,
      reasoning: task.reasoning ?? null,
      pr_url: task.pr_url,
      pr_role: task.kind === "review" ? "reviewed" : "authored",
      review_outcome: task.review_outcome ?? null,
      branch: task.branch,
      base_branch: task.base_branch,
      repo_path: task.repo_path,
      jira_key: task.jira_key,
      jira_parent_key: task.jira_parent_key,
      jira_status: task.jira_status ?? null,
      created_ms: task.created_ms,
      updated_ms: task.updated_ms,
      dispatches: {
        count: dispatchAgg?.count ?? dispatchAt.length,
        at_ms: dispatchAt.length ? dispatchAt : dispatchAgg ? [dispatchAgg.first_ms, dispatchAgg.last_ms].filter((v, i, a) => a.indexOf(v) === i) : [],
        gaps_ms: gaps,
      },
      items_in_window: {
        total: taskItems.length,
        open: taskItems.filter((i) => i.status === "open").length,
        question_open: taskItems.filter((i) => i.kind === "question" && i.status === "open").length,
        pr_open: taskItems.filter((i) => i.kind === "pr" && i.status === "open").length,
        resolved: taskItems.filter((i) => i.status === "resolved").length,
        archived: taskItems.filter((i) => i.status === "archived").length,
      },
      pr: readPrSnapshot(task.pr_meta),
      usage: usage
        ? { cost_usd: usage.cost_usd, tokens: usage.tokens, models: usage.models, agents: usage.agents, unpriced_calls: usage.unpriced_calls }
        : null,
      flags,
    };
  });

  // Items: attach their task and the event counts that explain status drift.
  const prItemsByTask = new Map<string, Item[]>();
  for (const item of itemRows) {
    if (item.kind !== "pr" || !item.task_id) continue;
    const list = prItemsByTask.get(item.task_id);
    if (list) list.push(item);
    else prItemsByTask.set(item.task_id, [item]);
  }

  const evidenceItems: EvidenceItem[] = itemRows.map((item) => {
    const agg = aggByRef.get(item.id);
    const events: EvidenceItem["events"] = {};
    for (const name of ITEM_EVENTS) {
      const row = agg?.get(name);
      if (row) events[shortEvent(name)] = { count: row.count, first_ms: row.first_ms, last_ms: row.last_ms };
    }
    const task = item.task_id ? taskById.get(item.task_id) ?? null : null;
    const flags: string[] = [];
    if (item.task_id && /\s/.test(item.task_id)) flags.push("malformed_task_id");
    if (item.task_id && !task) flags.push(unloadedExisting.has(item.task_id) ? "task_not_loaded" : "orphan_task");
    if (task && !inTaskWindow.has(task.id)) flags.push("outside_task_window");
    if (item.kind === "pr" && item.task_id && (prItemsByTask.get(item.task_id)?.length ?? 0) > 1) flags.push("duplicate_pr_item");
    if (agg?.get("item.resolved") && (item.status === "resolved" || item.status === "archived") && item.resolved_ms === null) {
      flags.push("resolved_without_timestamp");
    }
    if ((agg?.get("item.resolved")?.count ?? 0) > 1) flags.push("multiple_resolution_events");
    if (item.status === "archived" && item.resolved_ms === null) flags.push("archived_without_resolution");
    if (item.status !== "open" && isPublishQuestion(item) && !agg?.get("item.replied")) flags.push("review_publish_unanswered");
    const resolvedAt = item.resolved_ms ?? (item.status === "resolved" || item.status === "archived" ? agg?.get("item.resolved")?.last_ms ?? null : null);
    return {
      id: item.id,
      kind: item.kind,
      status: item.status,
      title: item.title,
      task_id: item.task_id,
      task: task
        ? { id: task.id, label: taskLabel(task), status: task.status, kind: task.kind ?? "code", in_task_window: inTaskWindow.has(task.id) }
        : null,
      created_ms: item.created_ms,
      updated_ms: item.updated_ms,
      resolved_ms: item.resolved_ms,
      waited_ms: resolvedAt !== null ? resolvedAt - item.created_ms : null,
      first_reply_ms: agg?.get("item.replied")?.first_ms ?? null,
      events,
      flags,
    };
  });

  const repeated = evidenceTasks
    .filter((t) => t.dispatches.count > 1)
    .map((t) => ({ task_id: t.id, count: t.dispatches.count, gaps_ms: t.dispatches.gaps_ms }));
  const resolvedWithoutTimestamp = evidenceItems
    .filter((i) => i.flags.includes("resolved_without_timestamp"))
    .map((i) => ({ item_id: i.id, resolved_event_ms: i.events.resolved?.last_ms ?? 0 }));
  const multipleResolutions = evidenceItems
    .filter((i) => i.flags.includes("multiple_resolution_events"))
    .map((i) => ({ item_id: i.id, count: i.events.resolved?.count ?? 0, first_ms: i.events.resolved?.first_ms ?? 0, last_ms: i.events.resolved?.last_ms ?? 0 }));

  const unpublishedReviews = evidenceItems
    .filter((i) => i.flags.includes("review_publish_unanswered"))
    .map((i) => ({ item_id: i.id, task_id: i.task_id, status: i.status }));

  const usage = opts.usage ?? null;
  return {
    window: { since_ms: since, generated_ms: now, days },
    limits: { days, tasks: taskLimit, linked_tasks: linkedTaskLimit, items: itemLimit, events: eventLimit },
    truncated: {
      tasks: taskCount > recentTasks.length,
      linked_tasks: candidateLinkedIds.length > linkedIds.length,
      items: itemCount > itemRows.length,
      events: lifecycleCount > eventRows.length,
    },
    gaps: [
      "Production outcomes are not recorded: a merged PR only proves delivery to the base branch.",
      "Review thread bodies are not persisted; only the unresolved count and ids are available.",
      "PR snapshots (checks, mergeability, thread counts) exist only for syncs that ran after they were added.",
      "Events and items are capped as listed in limits/truncated; counts come from aggregate queries, not the sampled event list.",
      usage
        ? "Costs are API-list-price estimates from local agent logs, not billed amounts."
        : "Usage costs were unavailable for this run.",
    ],
    tasks: evidenceTasks,
    items: evidenceItems,
    events: eventRows.map((e) => ({ ts: e.ts, name: e.name, ref: e.ref, data: parseData(e.data) })),
    data_quality: {
      untitled_tasks: evidenceTasks.filter((t) => !t.title.trim()).map((t) => t.id),
      tasks_without_model: evidenceTasks.filter((t) => !t.model).map((t) => t.id),
      done_without_pr: evidenceTasks.filter((t) => t.flags.includes("done_without_pr")).map((t) => t.id),
      review_tasks_with_pr_url: evidenceTasks.filter((t) => t.flags.includes("review_task_stores_reviewed_pr")).map((t) => t.id),
      repeated_dispatches: repeated,
      orphan_items: evidenceItems
        .filter((i) => i.flags.includes("orphan_task"))
        .map((i) => ({ item_id: i.id, task_id: i.task_id ?? "" })),
      malformed_task_ids: evidenceItems
        .filter((i) => i.flags.includes("malformed_task_id"))
        .map((i) => ({ item_id: i.id, task_id: i.task_id ?? "" })),
      resolved_without_timestamp: resolvedWithoutTimestamp,
      archived_without_resolution: evidenceItems.filter((i) => i.flags.includes("archived_without_resolution")).map((i) => i.id),
      multiple_resolution_events: multipleResolutions,
      duplicate_pr_items: [...prItemsByTask.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([task_id, list]) => ({ task_id, item_ids: list.map((i) => i.id) })),
      open_pr_items: evidenceItems
        .filter((i) => i.kind === "pr" && i.status === "open")
        .map((i) => ({ item_id: i.id, task_id: i.task_id, age_ms: now - i.created_ms })),
      unpublished_reviews: { count: unpublishedReviews.length, items: unpublishedReviews },
      items_outside_task_window: evidenceItems.filter((i) => i.flags.includes("outside_task_window")).length,
    },
    usage,
  };
}

function shortEvent(name: string): string {
  return name.startsWith("item.") ? name.slice(5) : name;
}
