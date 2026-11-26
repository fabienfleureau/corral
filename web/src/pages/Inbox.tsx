// Inbox — mail-style two-pane dispatch-and-review view.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ApiError, api } from "../api";
import type { Item, Repo, SessionInfo, Task, TrackedTerminal } from "../types";
import { errText, formatTs, itemPrUrl, prLabel, snoozeUntil, timeAgo } from "../util";
import { ExternalLinkIcon, JiraPill, KindIcon, Spinner } from "../ui";
import { Markdown } from "../markdown";
import { ItemBody } from "../item-body";
import { PlanView, type PlanStaleConflict } from "../PlanView";
import { clearPlanDraft } from "../plan-draft";
import { agentRunStatus, inProgressInboxItems, inProgressInboxTasks, isHandlingItem, isRepeatSnoozed, openInboxItems, repeatSnoozedFirst, selectedInboxItem, taskLocation, type AgentRunStatus } from "../inbox-selection";
import { INBOX_ACTION_COOLDOWN_MS, inboxActionsLocked } from "../inbox-action-lock";
import { useVisibleInboxItems } from "../use-visible-inbox-items";
import { inboxTitle, itemDisplayTitle } from "../inbox-title";
import { replyQuestions } from "../question-reply";
import { parseGrillRound, formatGrillAnswers } from "../grill-format";
import { QuestionReply } from "../QuestionReply";
import { GrillRoundDialog } from "../GrillRoundDialog";
import { TaskHistoryButton } from "../TaskHistory";
import { RedactedMarkdownButtons } from "../RedactedMarkdown";
import { inboxReportMarkdown } from "../redacted-export";
import { ResizeHandle } from "../ResizeHandle";
import { usePaneFlag, usePaneWidth } from "../use-pane-size";
import type { PaneLimits } from "../pane-size";
import { visibleStripEntries, type QuickJumpRef } from "../recents-pins";
import { useRecentsPins } from "../use-recents-pins";
import { PinButton, RecentsStrip, type StripEntry } from "../RecentsStrip";
import { combineRowImages, extractArtifactBadges, extractMarkdownImages, taskAttachmentPreviews } from "../row-previews";
import { PreviewToggleButton, RowPreviews } from "../RowPreviews";

type StatusFilter = "open" | "snoozed" | "in-progress";

const LIST_LIMITS: PaneLimits = { min: 260, max: 640 };
const LIST_DEFAULT_WIDTH = 380;
/** The detail pane never gets squeezed below this. */
const DETAIL_MIN_WIDTH = 320;

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "snoozed", label: "Snoozed" },
  { key: "in-progress", label: "In progress" },
];

type PrTriageView = {
  tier: "routine" | "deep";
  depth: "quick" | "standard" | "deep";
  mode: "observe";
  reasons: string[];
  source: "policy" | "default";
};

function parseItemTriage(raw: string | null | undefined): PrTriageView | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PrTriageView>;
    if ((v.tier !== "routine" && v.tier !== "deep") || !Array.isArray(v.reasons)) return null;
    return {
      tier: v.tier,
      depth: v.depth === "quick" || v.depth === "standard" || v.depth === "deep" ? v.depth : v.tier === "deep" ? "deep" : "standard",
      mode: "observe",
      reasons: v.reasons.filter((r): r is string => typeof r === "string"),
      source: v.source === "policy" ? "policy" : "default",
    };
  } catch {
    return null;
  }
}

function PrTriageBadge({ raw, detailed = false }: { raw: string | null | undefined; detailed?: boolean }) {
  const triage = parseItemTriage(raw);
  if (!triage) return null;
  const label = triage.tier === "deep" ? "deep review" : "routine skim";
  const reason = triage.reasons.join("; ");
  const tooltip = reason
    ? `Observe-only triage (${triage.depth} depth): ${reason}`
    : `Observe-only triage (${triage.depth} depth)`;
  return (
    <span className={`badge badge-triage-${triage.tier}`} title={tooltip}>
      {detailed && reason ? `${label} — ${reason}` : label}
    </span>
  );
}

function AgentRunBadge({ status }: { status: AgentRunStatus }) {
  const label = status === "running" ? "agent running" : status === "stopped" ? "agent stopped" : "agent status unknown";
  const title = status === "running"
    ? "Omnigent session is working or waiting on you."
    : status === "stopped"
      ? "Omnigent session stopped while this task is still dispatched."
      : "No Omnigent session status is available for this task.";
  return <span className={`badge badge-agent-${status}`} title={title}>{label}</span>;
}

/** Force refresh: re-check the task's PR/MR now and hand any unaddressed
 *  review comments or merge conflicts to the agent — the manual escape hatch
 *  of the PR loop when an automatic hand-off did not land. */
function ForcePrRefresh({ task, onChecked }: { task: Task; onChecked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const res = await api.checkPr(task.id, { force: true });
      const delivered = res.delivered;
      if (!delivered) {
        setNote(res.pr ? "Checked — nothing new to hand to the agent." : "No PR/MR found for this branch yet.");
      } else if (!delivered.address) {
        // The PR loop could not reach an agent: retryable, so say what failed.
        setError("Could not hand the work to an agent. Check the session, then retry.");
      } else {
        const what = [
          delivered.comments ? "review comments" : "",
          delivered.conflict ? "merge conflicts" : "",
          delivered.checks ? "failing checks" : "",
        ]
          .filter(Boolean)
          .join(" and ");
        setNote(`Sent ${what} to the agent.`);
      }
      onChecked();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        className="btn"
        onClick={() => void run()}
        disabled={busy}
        title="Check this PR/MR now and hand unaddressed review comments, merge conflicts, or failing checks to the agent"
      >
        {busy ? <Spinner /> : null}
        {busy ? "Refreshing…" : "Force refresh"}
      </button>
      {note ? <span className="inline-ok">{note}</span> : null}
      {error ? <span className="inline-error">{error}</span> : null}
    </>
  );
}

function RequestArtifact({ task }: { task: Task }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (task.target !== "claude" || task.status !== "dispatched" || !task.terminal_address) return null;
  const run = async () => {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      await api.requestArtifact(task.id);
      setNote("Request sent. Claude will report the artifact link in the inbox.");
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  };
  return <>
    <button className="btn" disabled={busy} onClick={() => void run()}>{busy ? "Requesting…" : "Ask Claude for an artifact"}</button>
    {note ? <span className="inline-ok" role="status">{note}</span> : null}
    {error ? <span className="inline-error" role="alert">{error}</span> : null}
  </>;
}

export function InboxPage({ active, eventVersion, refresh, onSeen }: { active: boolean; eventVersion: number; refresh: () => void; onSeen: (items: Item[]) => void }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [terminals, setTerminals] = useState<TrackedTerminal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncRequest, setSyncRequest] = useState<"idle" | "requesting" | "requested" | "error">("idle");
  const [selected, setSelected] = useState<Item | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const listSize = usePaneWidth("corral.inboxListWidth", LIST_DEFAULT_WIDTH, LIST_LIMITS);
  const [showPreviews, setShowPreviews] = usePaneFlag("corral.inboxPreviews");
  const { recents, pins, recordRecent, togglePin, isPinned } = useRecentsPins("corral.inboxRecents", "corral.inboxPins");

  const [replyText, setReplyText] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyOk, setReplyOk] = useState<string | null>(null);
  const [summarizeBusy, setSummarizeBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionUnlockAt, setActionUnlockAt] = useState(0);
  const [actionClock, setActionClock] = useState(0);
  const actionsLocked = inboxActionsLocked(actionBusy, actionUnlockAt, actionClock);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  const [attachCmd, setAttachCmd] = useState<string | null>(null);
  const [grillOpen, setGrillOpen] = useState(false);
  const [planViewing, setPlanViewing] = useState<{ revisionId: string | null; version: number | null }>({ revisionId: null, version: null });
  const [planConflict, setPlanConflict] = useState<PlanStaleConflict | null>(null);
  const [approvePlanBusy, setApprovePlanBusy] = useState(false);
  const [planNotice, setPlanNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);

  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  const handlePlanViewingChange = useCallback((revisionId: string | null, version: number | null) => {
    setPlanViewing((prev) => (prev.revisionId === revisionId && prev.version === version ? prev : { revisionId, version }));
  }, []);

  const clearPlanConflict = useCallback(() => setPlanConflict(null), []);

  // A different item must not inherit an open interview round or stale plan notice.
  useEffect(() => {
    setGrillOpen(false);
    setPlanConflict(null);
    setPlanViewing({ revisionId: null, version: null });
  }, [selected?.id]);

  // The cooldown outlives the selected item: the next one moves under the
  // same buttons as soon as the current item leaves the list.
  useEffect(() => {
    if (actionUnlockAt <= actionClock) return;
    const timer = setTimeout(() => setActionClock(Date.now()), actionUnlockAt - actionClock);
    return () => clearTimeout(timer);
  }, [actionUnlockAt, actionClock]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.listItems(),
      api.listTasks(),
      api.listRepos().catch(() => [] as Repo[]),
      api.listSessions().catch(() => [] as SessionInfo[]),
      api.listTerminals().catch(() => [] as TrackedTerminal[]),
    ])
      .then(([itemList, taskList, repoList, sessionList, terminalList]) => {
        if (cancelled) return;
        setAllItems(itemList);
        setTasks(taskList);
        setRepos(repoList);
        setSessions(sessionList);
        setTerminals(terminalList);
        setError(null);
        setSelected((prev) => selectedInboxItem(prev, itemList, statusFilter));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, eventVersion, statusFilter]);

  // Opening the inbox re-checks PRs: merged ones get resolved (server
  // broadcasts the changes, which bumps eventVersion and reloads the list).
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const sync = () => {
      if (document.visibilityState !== "visible") return;
      setSyncRequest("requesting");
      void api.syncPrs().then(() => { if (!cancelled) setSyncRequest("requested"); })
        .catch(() => { if (!cancelled) setSyncRequest("error"); });
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", sync); };
  }, [active]);

  const visibleItems = useVisibleInboxItems(allItems);
  const snoozedVisible = useVisibleInboxItems(allItems, "snoozed");
  const snoozedItems = useMemo(() => repeatSnoozedFirst(snoozedVisible), [snoozedVisible]);
  const inProgressItems = useMemo(() => inProgressInboxItems(allItems, tasks), [allItems, tasks]);
  const inProgressTasks = useMemo(
    () => inProgressInboxTasks(tasks, allItems, sessions, terminals),
    [tasks, allItems, sessions, terminals],
  );
  const openItems = useMemo(() => openInboxItems(visibleItems), [visibleItems]);
  const items = statusFilter === "snoozed" ? snoozedItems : statusFilter === "in-progress" ? inProgressItems : openItems;
  useEffect(() => {
    const acknowledge = () => {
      if (active && !loading && !error && statusFilter === "open" && document.visibilityState === "visible") onSeen(items);
    };
    acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    return () => document.removeEventListener("visibilitychange", acknowledge);
  }, [active, items, loading, error, statusFilter, onSeen]);

  const counts: Record<StatusFilter, number> = { open: openItems.length, snoozed: snoozedItems.length, "in-progress": inProgressItems.length + inProgressTasks.length };

  // Auto-select the first row when nothing is selected.
  useEffect(() => {
    if (selectedTaskId && statusFilter === "in-progress" && inProgressTasks.some((task) => task.id === selectedTaskId)) return;
    if (selectedTaskId) setSelectedTaskId(null);
    const current = selectedInboxItem(selected, items, statusFilter);
    if (current !== selected) setSelected(current ?? items[0] ?? null);
    else if (selected === null && items.length > 0) setSelected(items[0]);
  }, [items, selected, selectedTaskId, inProgressTasks, statusFilter]);

  const tasksById = useMemo(() => {
    const map: Record<string, Task> = {};
    for (const t of tasks) map[t.id] = t;
    return map;
  }, [tasks]);

  const itemsById = useMemo(() => {
    const map = new Map<string, Item>();
    for (const item of allItems) map.set(item.id, item);
    return map;
  }, [allItems]);

  const inProgressItemIds = useMemo(() => new Set(inProgressItems.map((i) => i.id)), [inProgressItems]);
  const snoozedItemIds = useMemo(() => new Set(snoozedItems.map((i) => i.id)), [snoozedItems]);
  const inProgressTaskIds = useMemo(() => new Set(inProgressTasks.map((t) => t.id)), [inProgressTasks]);

  const selectInboxEntry = useCallback((entry: QuickJumpRef) => {
    if (entry.kind === "task") {
      if (!inProgressTaskIds.has(entry.id)) return;
      setStatusFilter("in-progress");
      setSelected(null);
      setSelectedTaskId(entry.id);
      setPlanNotice(null);
      recordRecent(entry);
      return;
    }
    const item = itemsById.get(entry.id);
    if (!item) return;
    const nextFilter: StatusFilter = inProgressItemIds.has(item.id)
      ? "in-progress"
      : snoozedItemIds.has(item.id)
        ? "snoozed"
        : "open";
    setStatusFilter(nextFilter);
    setSelectedTaskId(null);
    setSelected(item);
    setPlanNotice(null);
    recordRecent(entry);
  }, [inProgressItemIds, inProgressTaskIds, itemsById, recordRecent, snoozedItemIds]);

  const resolveStripEntry = useCallback((ref: QuickJumpRef): StripEntry | null => {
    if (ref.kind === "task") {
      const task = tasksById[ref.id];
      if (!task) return null;
      return {
        ref,
        label: task.title || task.prompt.trim().split("\n")[0] || "Untitled task",
        badge: "task",
      };
    }
    const item = itemsById.get(ref.id);
    if (!item) return null;
    return {
      ref,
      label: inboxTitle(item, sessions),
      badge: item.kind,
    };
  }, [itemsById, sessions, tasksById]);

  const stripEntries = useMemo(() => {
    const { pinned, recents: filteredRecents } = visibleStripEntries(
      pins,
      recents,
      (ref) => (ref.kind === "task" ? inProgressTaskIds.has(ref.id) : itemsById.has(ref.id)),
    );
    return {
      pinned: pinned.map(resolveStripEntry).filter((entry): entry is StripEntry => entry !== null),
      recents: filteredRecents.map(resolveStripEntry).filter((entry): entry is StripEntry => entry !== null),
    };
  }, [inProgressTaskIds, itemsById, pins, recents, resolveStripEntry]);

  const activeStripRef: QuickJumpRef | null = selectedTaskId
    ? { kind: "task", id: selectedTaskId }
    : selected
      ? { kind: "item", id: selected.id }
      : null;

  const applyItem = (updated: Item) => {
    setSelected(updated);
    setAllItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    refresh();
  };

  const lockActions = () => {
    const now = Date.now();
    setActionUnlockAt(now + INBOX_ACTION_COOLDOWN_MS);
    setActionClock(now);
  };

  const runAction = async (fn: () => Promise<Item>) => {
    if (actionsLocked) return;
    setActionBusy(true);
    setActionError(null);
    try {
      applyItem(await fn());
      lockActions();
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setActionBusy(false);
    }
  };

  const sendReply = async (override?: string, permission?: string, answers?: Record<string, string | string[]>) => {
    const text = (override ?? replyText).trim();
    if (!selected || (!text && !permission && !answers) || replyBusy || actionsLocked) return;
    setReplyBusy(true);
    setReplyError(null);
    setReplyOk(null);
    try {
      const res = answers ? await api.replyAnswers(selected.id, answers) : permission ? await api.replyPermission(selected.id, permission) : await api.replyItem(selected.id, text);
      setReplyOk(`Sent to ${res.sent_to}`);
      setReplyText("");
      setGrillOpen(false);
      applyItem(res.item ?? { ...selected, status: "resolved", resolved_ms: Date.now(), snooze_until_ms: null });
      lockActions();
    } catch (err) {
      setReplyError(errText(err));
    } finally {
      setReplyBusy(false);
    }
  };

  const openConversation = async () => {
    if (!selected?.source_ref || openBusy) return;
    setOpenBusy(true);
    setActionError(null);
    setAttachCmd(null);
    try {
      const res = await api.openSession(selected.source_ref);
      if (res.url) window.open(res.url, "_blank", "noopener");
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setOpenBusy(false);
    }
  };

  const archiveTask = async (task: Task) => {
    if (actionsLocked) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const updated = await api.archiveTask(task);
      setTasks((prev) => prev.map((entry) => entry.id === updated.id ? updated : entry));
      setSelectedTaskId(null);
      refresh();
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setActionBusy(false);
    }
  };

  const openTaskSession = async (address: string) => {
    if (openBusy) return;
    setOpenBusy(true);
    setActionError(null);
    try {
      const result = await api.openSession(address);
      if (result.url) window.open(result.url, "_blank", "noopener");
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setOpenBusy(false);
    }
  };

  const onReplyKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void sendReply();
    }
  };

  const summarize = async () => {
    if (!selected || summarizeBusy) return;
    setSummarizeBusy(true);
    setActionError(null);
    try {
      applyItem(await api.summarizeItem(selected.id));
    } catch (err) {
      setActionError(errText(err));
    } finally {
      setSummarizeBusy(false);
    }
  };

  const changeFilter = (next: StatusFilter) => {
    if (next === statusFilter) return;
    setStatusFilter(next);
    setSelected(null);
    setSelectedTaskId(null);
    setPlanNotice(null);
  };

  const linkedTask = selected?.task_id ? tasksById[selected.task_id] ?? null : null;
  const selectedTask = selectedTaskId ? inProgressTasks.find((task) => task.id === selectedTaskId) ?? null : null;
  const selectedTaskLocation = taskLocation(selectedTask, repos);
  const linkedTaskLocation = taskLocation(linkedTask, repos);
  const grillRound = selected && linkedTask && (linkedTask.kind === "grill" || linkedTask.kind === "grill-docs") && !selected.elicitation
    ? parseGrillRound(selected.structured ? (selected.summary || selected.body) : selected.body)
    : [];
  const prUrl = selected ? itemPrUrl(selected.body, linkedTask?.pr_url) : null;
  /** An item the agent is handling reads as "in progress", not "open". */
  const selectedInProgress = selected !== null && isHandlingItem(selected) && selected.status === "open";
  const now = Date.now();
  const refreshStatus = `${loading ? "Refreshing inbox" : error ? "Inbox refresh failed" : "Inbox up to date"}. ${syncRequest === "requesting" ? "Requesting GitHub/GitLab PR sync" : syncRequest === "requested" ? "GitHub/GitLab PR sync requested; completion status unavailable" : syncRequest === "error" ? "GitHub/GitLab PR sync request failed" : "GitHub/GitLab PR sync not requested"}`;

  return (
    <div className="page inbox-page" style={active ? undefined : { display: "none" }}>
      <div className="list-pane" style={{ width: listSize.width }}>
        <div className="list-toolbar">
          <div className="chip-row">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                className={`chip ${statusFilter === f.key ? "chip-active" : ""}`}
                onClick={() => changeFilter(f.key)}
              >
                {f.label}
                <span className="chip-count">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <PreviewToggleButton enabled={showPreviews} onToggle={() => setShowPreviews(!showPreviews)} />
          <span className={`inbox-refresh-status ${error || syncRequest === "error" ? "inbox-refresh-error" : ""}`}
            role="status" aria-label={refreshStatus} title={refreshStatus}>
            {loading || syncRequest === "requesting" ? <Spinner /> : error || syncRequest === "error" ? "!" : "✓"}
          </span>
        </div>
        <RecentsStrip
          pinned={stripEntries.pinned}
          recents={stripEntries.recents}
          activeRef={activeStripRef}
          onSelect={selectInboxEntry}
          onUnpin={togglePin}
        />
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="item-list">
          {statusFilter === "in-progress" && inProgressTasks.map((task) => {
            const location = taskLocation(task, repos);
            const taskRef: QuickJumpRef = { kind: "task", id: task.id };
            const taskTitleText = task.title || task.prompt.trim().split("\n")[0] || "Untitled task";
            const taskImages = showPreviews
              ? combineRowImages(taskAttachmentPreviews(task.id, task.image_attachments), extractMarkdownImages(task.prompt))
              : { visible: [], extraCount: 0 };
            const taskArtifacts = showPreviews
              ? extractArtifactBadges({ text: task.prompt, title: task.title })
              : [];
            return (
              <div key={task.id} role="button" tabIndex={0}
                className={`item-row ${selectedTaskId === task.id ? "selected" : ""}`}
                onClick={() => { setSelected(null); setSelectedTaskId(task.id); recordRecent(taskRef); }}
                onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(null); setSelectedTaskId(task.id); recordRecent(taskRef); } }}>
                <span className="item-row-main">
                  <span className="item-row-title">{taskTitleText}</span>
                  {location ? (
                    <span className="item-row-context" title={location.path}>
                      {location.isRepo ? location.label : location.path}
                    </span>
                  ) : null}
                  <span className="item-row-sub">
                    <span>Task · in progress</span>
                    <AgentRunBadge status={agentRunStatus(task, sessions, terminals)} />
                  </span>
                  {showPreviews ? (
                    <RowPreviews images={taskImages.visible} extraCount={taskImages.extraCount} artifacts={taskArtifacts} />
                  ) : null}
                </span>
                <span className="item-row-side">
                  <span className="item-row-side-top">
                    <PinButton pinned={isPinned(taskRef)} label={taskTitleText} onToggle={() => togglePin(taskRef)} />
                    <span className="time" title={formatTs(task.created_ms)}>{timeAgo(task.created_ms)}</span>
                  </span>
                  <JiraPill jiraKey={task.jira_key} jiraUrl={task.jira_url} />
                </span>
              </div>
            );
          })}
          {loading && items.length === 0 && (statusFilter !== "in-progress" || inProgressTasks.length === 0) ? (
            <div className="pane-note">
              <Spinner label="Loading…" />
            </div>
          ) : items.length === 0 && (statusFilter !== "in-progress" || inProgressTasks.length === 0) ? (
            <div className="pane-note">{statusFilter === "open" ? "Nothing needs you." : "Nothing here."}</div>
          ) : (
            items.map((item) => {
              const needsYou = item.status === "open" && (item.kind === "question" || item.kind === "plan" || item.kind === "launch" || item.kind === "amendment");
              const snoozed = item.status === "open" && !isHandlingItem(item) && item.snooze_until_ms !== null && item.snooze_until_ms > Date.now();
              const rowTask = item.task_id ? tasksById[item.task_id] : undefined;
              const rowLocation = statusFilter === "in-progress" ? taskLocation(rowTask, repos) : null;
              const rowPr = itemPrUrl(item.body, rowTask?.pr_url);
              const itemRef: QuickJumpRef = { kind: "item", id: item.id };
              const titleText = inboxTitle(item, sessions);
              const rowImages = showPreviews
                ? combineRowImages(
                    rowTask ? taskAttachmentPreviews(rowTask.id, rowTask.image_attachments) : [],
                    extractMarkdownImages(`${item.summary}\n${item.body}`),
                  )
                : { visible: [], extraCount: 0 };
              const rowArtifacts = showPreviews
                ? extractArtifactBadges({ text: `${item.summary}\n${item.body}\n${rowTask?.prompt ?? ""}`, title: titleText })
                : [];
              return (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  className={`item-row ${needsYou ? "needs-you" : ""} ${selected?.id === item.id ? "selected" : ""}`}
                  onClick={() => { setSelectedTaskId(null); setSelected(item); recordRecent(itemRef); }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedTaskId(null);
                      setSelected(item);
                      recordRecent(itemRef);
                    }
                  }}
                >
                  <KindIcon kind={item.kind} />
                  <span className="item-row-main">
                    <span className="item-row-title">{titleText}</span>
                    {rowLocation ? (
                      <span className="item-row-context" title={rowLocation.path}>
                        {rowLocation.isRepo ? rowLocation.label : rowLocation.path}
                      </span>
                    ) : null}
                    <span className="item-row-sub">
                      <span className="kind-label">{item.kind}</span>
                      <span>·</span>
                      <span>{item.structured ? "structured" : "auto-captured"}</span>
                      {item.kind === "pr" && item.status === "open" ? (
                        <>
                          {item.handling === 1 ? (
                            <span className="badge badge-mine">agent working</span>
                          ) : item.ready === 1 ? (
                            <span className={`badge ${item.summary === "ready to merge" ? "badge-ready" : "badge-mine"}`}>{item.summary === "ready to merge" ? "ready to merge" : "ready for review"}</span>
                          ) : (
                            <span className="badge badge-wait">needs work</span>
                          )}
                          {item.ready === 1 && item.handling !== 1 ? <PrTriageBadge raw={item.triage} /> : null}
                        </>
                      ) : item.kind === "plan" && item.status === "open" && item.handling === 1 ? (
                        <span className="badge badge-mine">agent revising</span>
                      ) : null}
                    </span>
                    {showPreviews ? (
                      <RowPreviews images={rowImages.visible} extraCount={rowImages.extraCount} artifacts={rowArtifacts} />
                    ) : null}
                  </span>
                  <span className="item-row-side">
                    <span className="item-row-side-top">
                      <PinButton pinned={isPinned(itemRef)} label={titleText} onToggle={() => togglePin(itemRef)} />
                      <span className="time" title={formatTs(item.created_ms)}>
                        {timeAgo(item.created_ms)}
                      </span>
                    </span>
                    {needsYou ? <span className="badge badge-urgent">needs you</span> : null}
                    {isRepeatSnoozed(item) ? (
                      <span className="badge badge-snoozed" title="Snoozed again and again: decide, delegate or archive it">
                        snoozed {item.snooze_count}×
                      </span>
                    ) : snoozed ? <span className="badge badge-snoozed">snoozed</span> : null}
                    <JiraPill jiraKey={rowTask?.jira_key} jiraUrl={rowTask?.jira_url} />
                    {rowPr ? (
                      <a
                        href={rowPr}
                        target="_blank"
                        rel="noreferrer"
                        className="pr-pill"
                        title={rowPr}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {prLabel(rowPr)}
                        <ExternalLinkIcon />
                      </a>
                    ) : null}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <ResizeHandle
        label="Resize inbox list"
        width={listSize.width}
        limits={LIST_LIMITS}
        reserve={DETAIL_MIN_WIDTH}
        onChange={listSize.setWidth}
        onReset={listSize.reset}
      />

      <div className="detail-pane">
        {planNotice ? (
          <div
            className={`plan-approve-notice plan-approve-notice-${planNotice.kind}`}
            role={planNotice.kind === "warn" ? "alert" : "status"}
          >
            <span>
              {planNotice.text} <a href="#/tasks">Open tasks</a>
            </span>
            <button type="button" className="btn" onClick={() => setPlanNotice(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {selectedTask ? (
          <>
            <div className="detail-head">
              <div className="detail-title-row">
                <h2 className="detail-title">{selectedTask.title || selectedTask.prompt.trim().split("\n")[0] || "Untitled task"}</h2>
                <PinButton
                  pinned={isPinned({ kind: "task", id: selectedTask.id })}
                  label={selectedTask.title || selectedTask.prompt.trim().split("\n")[0] || "Untitled task"}
                  onToggle={() => togglePin({ kind: "task", id: selectedTask.id })}
                />
              </div>
              <div className="detail-meta">
                <span className="chip chip-static status-dispatched">in progress</span>
                <AgentRunBadge status={agentRunStatus(selectedTask, sessions, terminals)} />
                {selectedTaskLocation ? (
                  <span className="task-context" title={selectedTaskLocation.path}>
                    <span className={`chip chip-static${selectedTaskLocation.isRepo ? "" : " mono"}`}>
                      {selectedTaskLocation.isRepo ? selectedTaskLocation.label : selectedTaskLocation.path}
                    </span>
                    {selectedTaskLocation.isRepo ? <span className="mono muted task-context-path">{selectedTaskLocation.path}</span> : null}
                  </span>
                ) : null}
                <JiraPill jiraKey={selectedTask.jira_key} jiraUrl={selectedTask.jira_url} />
              </div>
            </div>
            <div className="detail-body"><Markdown text={selectedTask.prompt} className="body-text" /></div>
            <div className="detail-actions">
              <div className="action-row">
                {selectedTask.terminal_address ? (
                  <button className="btn btn-primary" disabled={openBusy} onClick={() => void openTaskSession(selectedTask.terminal_address!)}>
                    {openBusy ? "Opening…" : "View task"}
                  </button>
                ) : <span className="muted">No session available.</span>}
                <RequestArtifact key={selectedTask.id} task={selectedTask} />
                <TaskHistoryButton taskId={selectedTask.id} title={selectedTask.title || selectedTask.prompt.trim().split("\n")[0] || "Untitled task"} version={eventVersion} />
                {selectedTask.branch ? <ForcePrRefresh task={selectedTask} onChecked={refresh} /> : null}
                <button className="btn" disabled={actionsLocked} onClick={() => void archiveTask(selectedTask)} title="Archive this task and its session in Omnigent when it has one">
                  Archive task
                </button>
              </div>
              {actionError ? <div className="inline-error">{actionError}</div> : null}
            </div>
          </>
        ) : !selected ? (
          <div className="pane-note">Select an item to review it.</div>
        ) : (
          <>
            <div className="detail-head">
              <div className="detail-title-row">
                <h2 className="detail-title">{itemDisplayTitle(selected.title)}</h2>
                <PinButton
                  pinned={isPinned({ kind: "item", id: selected.id })}
                  label={itemDisplayTitle(selected.title)}
                  onToggle={() => togglePin({ kind: "item", id: selected.id })}
                />
                {prUrl ? (
                  <a href={prUrl} target="_blank" rel="noreferrer" className="btn btn-primary pr-open" title={prUrl}>
                    Open {prLabel(prUrl)}
                    <ExternalLinkIcon />
                  </a>
                ) : null}
              </div>
              <div className="detail-meta">
                <span className="chip chip-static">{selected.kind}</span>
                <span className="chip chip-static">
                  {selected.structured ? "structured report" : "auto-captured"}
                </span>
                {selected.kind === "pr" && selected.status === "open" ? (
                  <>
                    {selected.handling === 1 ? (
                      <span className="badge badge-mine">agent working — {selected.summary || "PR loop"}</span>
                    ) : selected.ready === 1 ? (
                      <span className={`badge ${selected.summary === "ready to merge" ? "badge-ready" : "badge-mine"}`}>{selected.summary === "ready to merge" ? "ready to merge" : "ready for review"}</span>
                    ) : (
                      <span className="badge badge-wait">needs work — {selected.summary || "see body"}</span>
                    )}
                    <PrTriageBadge raw={selected.triage} detailed />
                  </>
                ) : null}
                <span className={`chip chip-static status-${selectedInProgress ? "dispatched" : selected.status}`}>
                  {selectedInProgress ? "in progress" : selected.status === "resolved" ? "acknowledged" : selected.status}
                </span>
                {linkedTask ? (
                  <span className="meta-task">
                    Task: <strong>{linkedTask.title || linkedTask.prompt.trim().split("\n")[0].slice(0, 120) || "Untitled task"}</strong>
                    {selectedInProgress && linkedTaskLocation ? (
                      <span className={`chip chip-static${linkedTaskLocation.isRepo ? "" : " mono"}`} title={linkedTaskLocation.path}>
                        {linkedTaskLocation.isRepo ? linkedTaskLocation.label : linkedTaskLocation.path}
                      </span>
                    ) : null}
                    <JiraPill jiraKey={linkedTask.jira_key} jiraUrl={linkedTask.jira_url} />
                  </span>
                ) : null}
                <span className="time muted" title={formatTs(selected.created_ms)}>
                  {timeAgo(selected.created_ms)}
                </span>
              </div>
            </div>

            <div className="detail-body">
              {selected.kind === "plan" && linkedTask?.kind === "spec" ? (
                <PlanView
                  item={selected}
                  task={linkedTask}
                  eventVersion={eventVersion}
                  externalConflict={planConflict}
                  onClearExternalConflict={clearPlanConflict}
                  onViewingRevisionChange={handlePlanViewingChange}
                  onChangesRequested={(updated) => {
                    if (updated) applyItem(updated);
                    else refresh();
                  }}
                />
              ) : (
                <ItemBody item={selected} />
              )}
              {selected.context ? (
                <details className="context-drawer">
                  <summary>{selected.kind === "digest" && !selected.task_id ? "Analysis evidence" : "Recent agent output"}</summary>
                  <pre className="body-text body-raw">{selected.context}</pre>
                </details>
              ) : null}
              {!selected.summary && selected.kind === "question" ? (
                <div className="summarize-row">
                  <button className="btn" onClick={() => void summarize()} disabled={summarizeBusy}>
                    {summarizeBusy ? <Spinner /> : null}
                    {summarizeBusy ? "Summarizing…" : "Summarize"}
                  </button>
                  <span className="muted">Runs an LLM summary of the body (~10s).</span>
                </div>
              ) : null}
            </div>

            <div className={`detail-actions${grillRound.length > 0 ? " grill-actions" : ""}`}>
              <div className="action-row">
                {selected.source_ref ? (
                  <button className="btn btn-primary" onClick={() => void openConversation()} disabled={openBusy}>
                    {openBusy ? <Spinner /> : null}
                    {openBusy ? "Opening…" : "Open conversation"}
                  </button>
                ) : null}
                {selected.kind === "plan" && selected.status === "open" && linkedTask?.kind === "spec" ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => void (async () => {
                      if (actionsLocked) return;
                      setActionBusy(true);
                      setApprovePlanBusy(true);
                      setActionError(null);
                      setPlanConflict(null);
                      setPlanNotice(null);
                      try {
                        const res = await api.approvePlan(linkedTask.id, planViewing.revisionId ?? undefined);
                        if (planViewing.revisionId) clearPlanDraft(window.localStorage, linkedTask.id, planViewing.revisionId);
                        const total = res.children.length;
                        const errors = res.dispatch_errors ?? [];
                        const dispatched = total - errors.length;
                        const noun = total === 1 ? "task" : "tasks";
                        if (errors.length === 0) {
                          setPlanNotice({ kind: "ok", text: `Plan approved: ${total} ${noun} created and dispatched.` });
                        } else {
                          setPlanNotice({
                            kind: "warn",
                            text: `Plan approved: ${total} ${noun} created (${dispatched} dispatched). Dispatch failed for ${errors.map((e) => `${e.title}: ${e.error}`).join("; ")}`,
                          });
                        }
                        applyItem({ ...selected, status: "resolved", resolved_ms: Date.now() });
                        lockActions();
                      } catch (err: unknown) {
                        if (err instanceof ApiError && err.status === 409 && err.data?.current_revision_id) {
                          setPlanConflict({
                            fromRevisionId: planViewing.revisionId ?? "",
                            fromVersion: planViewing.version ?? 1,
                            toRevisionId: typeof err.data.current_revision_id === "string" ? err.data.current_revision_id : null,
                            toVersion: typeof err.data.current_version === "number" ? err.data.current_version : null,
                          });
                        } else {
                          setActionError(errText(err));
                        }
                      } finally {
                        setApprovePlanBusy(false);
                        setActionBusy(false);
                      }
                    })()}
                    disabled={actionsLocked}
                    title="Create and dispatch one task per sub-project, each carrying the contract"
                  >
                    {approvePlanBusy ? <Spinner /> : null}
                    {approvePlanBusy ? "Approving…" : "Approve plan"}
                  </button>
                ) : null}
                {selected.kind === "launch" && selected.status === "open" && linkedTask ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => linkedTask.target && linkedTask.repo_path
                      ? void runAction(async () => { await api.dispatchTask(linkedTask.id, {}); return api.resolveItem(selected.id); })
                      : void (window.location.hash = "/tasks")}
                    disabled={actionsLocked}
                    title={linkedTask.target && linkedTask.repo_path ? "Start the agent on this task" : "Pick a repository and a harness on the task first"}
                  >
                    {actionBusy ? <Spinner /> : null}
                    {linkedTask.target && linkedTask.repo_path ? "Launch" : "Open task"}
                  </button>
                ) : null}
                {selected.kind === "amendment" && selected.status === "open" ? (
                  <>
                    <button className="btn btn-primary" disabled={actionsLocked} title="Write this amendment into the Jira ticket and onto the task"
                      onClick={() => void runAction(() => api.applyAmendment(selected.id))}>
                      {actionBusy ? <Spinner /> : null}Apply to Jira
                    </button>
                    <button className="btn" disabled={actionsLocked}
                      onClick={() => void runAction(() => api.rejectAmendment(selected.id))}>Reject</button>
                  </>
                ) : null}
                {selected.kind === "pr" && linkedTask?.branch ? <ForcePrRefresh task={linkedTask} onChecked={refresh} /> : null}
                {linkedTask ? <RequestArtifact key={linkedTask.id} task={linkedTask} /> : null}
                {linkedTask ? <TaskHistoryButton taskId={linkedTask.id} title={linkedTask.title || linkedTask.prompt.trim().split("\n")[0] || "Untitled task"} version={eventVersion} /> : null}
                <RedactedMarkdownButtons markdown={inboxReportMarkdown(selected, linkedTask)} basename={`report-${selected.id}`} />
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.resolveItem(selected.id))}
                  disabled={actionsLocked || selected.status === "resolved"}
                >
                  Acknowledge
                </button>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.archiveItem(selected.id))}
                  disabled={actionsLocked || selected.status === "archived"}
                >
                  Archive
                </button>
                <span className="action-label">Snooze:</span>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.snoozeItem(selected.id, snoozeUntil("1h")))}
                  disabled={actionsLocked}
                >
                  1h
                </button>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.snoozeItem(selected.id, snoozeUntil("4h")))}
                  disabled={actionsLocked}
                >
                  4h
                </button>
                <button
                  className="btn"
                  onClick={() => void runAction(() => api.snoozeItem(selected.id, snoozeUntil("tomorrow")))}
                  disabled={actionsLocked}
                >
                  Tomorrow
                </button>
              </div>
              {actionError ? <div className="inline-error">{actionError}</div> : null}
              {attachCmd ? (
                <div className="inline-ok">
                  Open it yourself: <code className="mono">{attachCmd}</code>
                </div>
              ) : null}

              {selected.kind === "launch" || selected.kind === "amendment" || (selected.kind === "plan" && linkedTask?.kind === "spec") ? null : <div className="reply-block">
                {grillRound.length > 0 ? <>
                  <button type="button" className="btn btn-primary"
                    title="Open the interview round in a modal"
                    onClick={() => setGrillOpen(true)}>
                    {selected.status === "open" ? "Answer" : "View"} questions ({grillRound.length})
                  </button>
                  {grillOpen ? <GrillRoundDialog
                    key={selected.id + selected.updated_ms}
                    questions={grillRound}
                    title={linkedTask?.title || itemDisplayTitle(selected.title)}
                    disabled={replyBusy || actionsLocked || selected.status !== "open"}
                    error={replyError}
                    onSend={(answers) => sendReply(formatGrillAnswers(grillRound, answers))}
                    onClose={() => setGrillOpen(false)}
                  /> : null}
                </> : replyQuestions(selected.elicitation).length > 0 ? <>
                  <QuestionReply key={selected.id + selected.elicitation}
                    questions={replyQuestions(selected.elicitation)} disabled={replyBusy || actionsLocked || selected.status !== "open"}
                    onSend={(answers) => sendReply("", undefined, answers)} />
                  {replyError ? <span className="inline-error">{replyError}</span> : null}
                </> : <>
                {(() => {
                  try {
                    const elicitation = selected.elicitation ? JSON.parse(selected.elicitation) as { kind?: string; persistPattern?: string } : null;
                    if (elicitation?.kind !== "permission") return null;
                    const choices = [
                      { value: "approve", label: "Approve" },
                      ...(elicitation.persistPattern ? [
                        { value: "session", label: `Allow commands starting with ${elicitation.persistPattern} for this session` },
                        { value: "always", label: `Always allow commands starting with ${elicitation.persistPattern}` },
                      ] : []),
                      { value: "reject", label: "Reject" },
                    ];
                    return <div className="option-row">{choices.map(({ value, label }) => (
                      <button key={value} className={value === "approve" ? "btn btn-primary" : "btn option-btn"}
                        onClick={() => void sendReply("", value)} disabled={replyBusy || actionsLocked || selected.status !== "open"}>{label}</button>
                    ))}</div>;
                  } catch { return null; }
                })()}
                {(() => {
                  let options: string[] = [];
                  try {
                    options = selected.options ? (JSON.parse(selected.options) as string[]) : [];
                  } catch {
                    options = [];
                  }
                  return options.length > 0 ? (
                    <div className="option-row">
                      {options.map((opt) => (
                        <button
                          key={opt}
                          className="btn option-btn"
                          onClick={() => void sendReply(opt)}
                          disabled={replyBusy || actionsLocked || selected.status !== "open"}
                        >
                          {opt}
                        </button>
                      ))}
                      <span className="muted">…or type below</span>
                    </div>
                  ) : null;
                })()}
                <textarea
                  ref={replyRef}
                  className="reply-input"
                  placeholder="Reply to the agent's terminal…  (Cmd/Ctrl+Enter to send)"
                  value={replyText}
                  rows={3}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={onReplyKeyDown}
                />
                <div className="reply-foot">
                  <button className="btn btn-primary" onClick={() => void sendReply()} disabled={replyBusy || actionsLocked || !replyText.trim()}>
                    {replyBusy ? <Spinner /> : null}
                    {replyBusy ? "Sending…" : "Send & acknowledge"}
                  </button>
                  {replyOk ? <span className="inline-ok">{replyOk}</span> : null}
                  {replyError ? <span className="inline-error">{replyError}</span> : null}
                  {selected.snooze_until_ms !== null && selected.snooze_until_ms > now ? (
                    <span className="muted">Snoozed until {formatTs(selected.snooze_until_ms)}</span>
                  ) : null}
                </div>
                </>}
              </div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
