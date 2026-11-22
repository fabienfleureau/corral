// Multi-repo plan viewer: structured semantic reading view, revision switcher,
// dependency-free Markdown diff view, previous feedback drawer, and inline
// Request changes draft panel.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { Item, PlanRevision, PlanRevisionsResponse, Task } from "./types";
import { Markdown } from "./markdown";
import { Spinner } from "./ui";
import { errText, formatTs } from "./util";
import { diffMarkdown, type DiffLine } from "./plan-diff";
import {
  PLAN_COMMENT_EVENT,
  clearPlanDraft,
  emptyPlanDraft,
  hasPlanDraftContent,
  loadPlanDraft,
  savePlanDraft,
  type PlanCommentRequest,
  type PlanDraft,
  type PlanDraftComment,
} from "./plan-draft";

export type PlanStaleConflict = {
  fromRevisionId: string;
  fromVersion: number;
  toRevisionId: string | null;
  toVersion: number | null;
};

type Props = {
  item: Item;
  task: Task;
  eventVersion: number;
  externalConflict: PlanStaleConflict | null;
  onClearExternalConflict: () => void;
  onViewingRevisionChange: (revisionId: string | null, version: number | null) => void;
  onChangesRequested: (updatedItem: Item | null) => void;
};

function DiffLineRow({ line }: { line: DiffLine }) {
  const prefix = line.type === "add" ? "+" : line.type === "remove" ? "−" : " ";
  return (
    <div className={`plan-diff-line plan-diff-${line.type}`}>
      <span className="plan-diff-gutter" aria-hidden="true">{line.oldLine ?? ""}</span>
      <span className="plan-diff-gutter" aria-hidden="true">{line.newLine ?? ""}</span>
      <span className="plan-diff-sign" aria-hidden="true">{prefix}</span>
      <span className="plan-diff-code">
        {line.spans ? (
          line.spans.map((span, idx) =>
            span.changed ? (
              <mark key={idx} className={line.type === "add" ? "plan-diff-word-add" : "plan-diff-word-del"}>
                {span.text}
              </mark>
            ) : (
              <span key={idx}>{span.text}</span>
            ),
          )
        ) : (
          line.text || "\u00a0"
        )}
      </span>
    </div>
  );
}

export function PlanView({
  item,
  task,
  eventVersion,
  externalConflict,
  onClearExternalConflict,
  onViewingRevisionChange,
  onChangesRequested,
}: Props) {
  const [data, setData] = useState<PlanRevisionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [viewingRevisionId, setViewingRevisionId] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState(false);
  const [baseRevisionId, setBaseRevisionId] = useState<string | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Record<number, boolean>>({});

  const [draft, setDraft] = useState<PlanDraft>(emptyPlanDraft);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<string | null>(null);
  const [localConflict, setLocalConflict] = useState<PlanStaleConflict | null>(null);

  const noteId = useId();
  const baseSelectId = useId();
  const commentRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const viewingRef = useRef<string | null>(null);
  viewingRef.current = viewingRevisionId;
  const draftRef = useRef<PlanDraft>(draft);
  draftRef.current = draft;

  // Reset UI state when switching to a different spec task.
  useEffect(() => {
    setData(null);
    setViewingRevisionId(null);
    setDiffMode(false);
    setBaseRevisionId(null);
    setExpandedRuns({});
    setDraft(emptyPlanDraft());
    setSubmitError(null);
    setSubmitOk(null);
    setLocalConflict(null);
  }, [task.id]);

  // Load revisions initially and refresh on SSE updates.
  // Preserve a tab's v1 view when the reviewer has an unpublished draft on v1;
  // advance automatically to v2 when the reviewer was viewing the previous
  // latest revision with no draft.
  useEffect(() => {
    let cancelled = false;
    setLoading((prev) => (data === null ? true : prev));
    api
      .getPlanRevisions(task.id)
      .then((res) => {
        if (cancelled) return;
        setData((prevData) => {
          const prevCurrent = prevData?.current_revision_id ?? null;
          const curViewing = viewingRef.current;
          const hasDraft = hasPlanDraftContent(draftRef.current);
          if (!curViewing) {
            setViewingRevisionId(res.current_revision_id);
          } else if (
            res.current_revision_id &&
            res.current_revision_id !== prevCurrent &&
            curViewing === prevCurrent &&
            !hasDraft
          ) {
            setViewingRevisionId(res.current_revision_id);
          }
          return res;
        });
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, eventVersion]);

  const revisions = data?.revisions ?? [];
  const currentRevision = useMemo(
    () => revisions.find((r) => r.id === data?.current_revision_id) ?? revisions[revisions.length - 1] ?? null,
    [revisions, data?.current_revision_id],
  );
  const viewingRevision = useMemo(
    () => revisions.find((r) => r.id === viewingRevisionId) ?? currentRevision,
    [revisions, viewingRevisionId, currentRevision],
  );

  // Notify parent Inbox of the revision currently being viewed so Approve plan pins it.
  useEffect(() => {
    onViewingRevisionChange(viewingRevision?.id ?? null, viewingRevision?.version ?? null);
  }, [viewingRevision?.id, viewingRevision?.version, onViewingRevisionChange]);

  // Sync draft state from localStorage whenever the viewed revision changes.
  useEffect(() => {
    if (!viewingRevision) {
      setDraft(emptyPlanDraft());
      return;
    }
    setDraft(loadPlanDraft(window.localStorage, task.id, viewingRevision.id));
    setSubmitError(null);
    setSubmitOk(null);
  }, [task.id, viewingRevision?.id]);

  // Keep baseRevisionId valid when switching revisions.
  const earlierRevisions = useMemo(() => {
    if (!viewingRevision) return [] as PlanRevision[];
    return revisions.filter((r) => r.version < viewingRevision.version);
  }, [revisions, viewingRevision]);

  useEffect(() => {
    if (!viewingRevision || earlierRevisions.length === 0) {
      setDiffMode(false);
      setBaseRevisionId(null);
      return;
    }
    if (!baseRevisionId || !earlierRevisions.some((r) => r.id === baseRevisionId)) {
      setBaseRevisionId(earlierRevisions[earlierRevisions.length - 1].id);
    }
  }, [viewingRevision?.id, earlierRevisions, baseRevisionId]);

  // Reset collapsed-run expansion when the diff inputs change.
  useEffect(() => {
    setExpandedRuns({});
  }, [viewingRevision?.id, baseRevisionId, diffMode]);

  const isOpen = item.status === "open";
  const isHandling = (item.handling ?? 0) === 1;
  const isApproved = Boolean(data?.approved_revision_id);
  const isCurrent = Boolean(viewingRevision && currentRevision && viewingRevision.id === currentRevision.id);
  const isCommentable = isOpen && !isHandling && !isApproved && !diffMode && isCurrent;

  // Listen for "Comment" clicks from SelectionToTask.
  useEffect(() => {
    const onComment = (ev: Event) => {
      const detail = (ev as CustomEvent<PlanCommentRequest>).detail;
      if (!detail || detail.taskId !== task.id || detail.revisionId !== viewingRef.current) return;
      const newComment: PlanDraftComment = {
        id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        revision_id: detail.revisionId,
        section: detail.section,
        repo: detail.repo,
        quote: detail.quote,
        body: "",
      };
      setDraft((prev) => {
        const next: PlanDraft = { ...prev, comments: [...prev.comments, newComment] };
        savePlanDraft(window.localStorage, task.id, detail.revisionId, next);
        return next;
      });
      setFocusCommentId(newComment.id);
    };
    window.addEventListener(PLAN_COMMENT_EVENT, onComment);
    return () => window.removeEventListener(PLAN_COMMENT_EVENT, onComment);
  }, [task.id]);

  // Focus newly created comment composer textarea.
  useEffect(() => {
    if (!focusCommentId) return;
    const el = commentRefs.current[focusCommentId];
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setFocusCommentId(null);
    }
  }, [focusCommentId, draft.comments.length]);

  const updateDraft = (updater: (prev: PlanDraft) => PlanDraft) => {
    if (!viewingRevision) return;
    setDraft((prev) => {
      const next = updater(prev);
      savePlanDraft(window.localStorage, task.id, viewingRevision.id, next);
      return next;
    });
  };

  const baseRevision = useMemo(
    () => earlierRevisions.find((r) => r.id === baseRevisionId) ?? earlierRevisions[earlierRevisions.length - 1] ?? null,
    [earlierRevisions, baseRevisionId],
  );

  const diffResult = useMemo(() => {
    if (!diffMode || !viewingRevision || !baseRevision) return null;
    return diffMarkdown(baseRevision.markdown, viewingRevision.markdown);
  }, [diffMode, viewingRevision, baseRevision]);

  const conflict = externalConflict ?? localConflict;

  const openCompare = async (fromRevId: string, toRevId: string | null) => {
    setLocalConflict(null);
    onClearExternalConflict();
    let latest = data;
    try {
      latest = await api.getPlanRevisions(task.id);
      setData(latest);
    } catch {
      /* keep existing data if refresh fails */
    }
    const targetId = toRevId ?? latest?.current_revision_id ?? null;
    if (targetId) {
      setViewingRevisionId(targetId);
      setBaseRevisionId(fromRevId);
      setDiffMode(true);
    }
  };

  const submitRequestChanges = async () => {
    if (!viewingRevision || submitBusy) return;
    const validComments = draft.comments
      .map((c) => ({ section: c.section, repo: c.repo, quote: c.quote, body: c.body.trim() }))
      .filter((c) => c.body.length > 0);
    const trimmedNote = draft.note.trim();
    if (!trimmedNote && validComments.length === 0) {
      setSubmitError("Add a comment note or a general note before requesting changes.");
      return;
    }
    setSubmitBusy(true);
    setSubmitError(null);
    setSubmitOk(null);
    setLocalConflict(null);
    onClearExternalConflict();
    try {
      const res = await api.requestPlanChanges(task.id, {
        revision_id: viewingRevision.id,
        note: trimmedNote,
        comments: validComments,
      });
      clearPlanDraft(window.localStorage, task.id, viewingRevision.id);
      setDraft(emptyPlanDraft());
      setSubmitOk(`Feedback sent to ${res.sent_to}`);
      onChangesRequested(res.item);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409 && err.data?.current_revision_id) {
        const toRevId = typeof err.data.current_revision_id === "string" ? err.data.current_revision_id : null;
        const toVer = typeof err.data.current_version === "number" ? err.data.current_version : null;
        setLocalConflict({
          fromRevisionId: viewingRevision.id,
          fromVersion: viewingRevision.version,
          toRevisionId: toRevId,
          toVersion: toVer,
        });
      } else {
        setSubmitError(errText(err));
      }
    } finally {
      setSubmitBusy(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="plan-view">
        <div className="pane-note"><Spinner label="Loading plan revisions…" /></div>
      </div>
    );
  }

  if (loadError && !viewingRevision) {
    return (
      <div className="plan-view">
        <div className="inline-error" role="alert">{loadError}</div>
        <Markdown text={item.body} className="body-text" />
      </div>
    );
  }

  if (!viewingRevision) {
    return <Markdown text={item.body} className="body-text" />;
  }

  const revisionReviews = (data?.reviews ?? []).filter((r) => r.revision_id === viewingRevision.id);
  const allReviews = data?.reviews ?? [];
  const hasSubmitContent =
    draft.note.trim().length > 0 || draft.comments.some((c) => c.body.trim().length > 0);
  const incompleteComments = draft.comments.filter((c) => c.body.trim().length === 0).length;

  return (
    <div className="plan-view">
      <div className="plan-header">
        <div className="plan-rev-group" role="group" aria-label="Plan revisions">
          {revisions.length > 1 ? (
            revisions.map((rev) => (
              <button
                key={rev.id}
                type="button"
                className={`chip plan-rev-btn ${rev.id === viewingRevision.id ? "chip-active" : ""}`}
                aria-pressed={rev.id === viewingRevision.id}
                onClick={() => {
                  setViewingRevisionId(rev.id);
                  setLocalConflict(null);
                  onClearExternalConflict();
                }}
              >
                v{rev.version}
              </button>
            ))
          ) : (
            <span className="chip chip-static">v{viewingRevision.version}</span>
          )}
          {data?.approved_revision_id === viewingRevision.id ? (
            <span className="badge badge-ready">approved</span>
          ) : null}
        </div>

        <div className="plan-header-actions">
          {earlierRevisions.length > 0 ? (
            <>
              <button
                type="button"
                className={`btn plan-diff-toggle ${diffMode ? "btn-primary" : ""}`}
                aria-pressed={diffMode}
                onClick={() => setDiffMode((v) => !v)}
              >
                {diffMode
                  ? "Back to reading view"
                  : `Changes since v${baseRevision?.version ?? viewingRevision.version - 1}`}
              </button>
              {diffMode && earlierRevisions.length > 1 ? (
                <label className="plan-base-picker" htmlFor={baseSelectId}>
                  <span className="muted">Base</span>
                  <select
                    id={baseSelectId}
                    value={baseRevision?.id ?? ""}
                    onChange={(e) => setBaseRevisionId(e.target.value)}
                  >
                    {earlierRevisions.map((rev) => (
                      <option key={rev.id} value={rev.id}>
                        v{rev.version}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {!isCurrent && currentRevision ? (
        <div className="plan-banner plan-older-banner" role="status">
          <span>
            Viewing <strong>v{viewingRevision.version}</strong> — <strong>v{currentRevision.version}</strong> is current.
          </span>
          <div className="plan-banner-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void openCompare(viewingRevision.id, currentRevision.id)}
            >
              Compare v{viewingRevision.version} → v{currentRevision.version}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setViewingRevisionId(currentRevision.id);
                setDiffMode(false);
                setLocalConflict(null);
                onClearExternalConflict();
              }}
            >
              Jump to v{currentRevision.version}
            </button>
          </div>
        </div>
      ) : null}

      {conflict ? (
        <div className="plan-banner plan-stale-notice" role="alert">
          <span>
            Plan updated to <strong>v{conflict.toVersion ?? "?"}</strong> while you were reviewing{" "}
            <strong>v{conflict.fromVersion}</strong>. Your draft on v{conflict.fromVersion} is preserved.
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void openCompare(conflict.fromRevisionId, conflict.toRevisionId)}
          >
            Compare v{conflict.fromVersion} → v{conflict.toVersion ?? "latest"}
          </button>
        </div>
      ) : null}

      {diffMode && diffResult && baseRevision ? (
        <div className="plan-diff" aria-label={`Diff from v${baseRevision.version} to v${viewingRevision.version}`}>
          <div className="plan-diff-summary">
            <span>
              Comparing <strong>v{baseRevision.version}</strong> → <strong>v{viewingRevision.version}</strong>
            </span>
            {diffResult.identical ? (
              <span className="muted">No changes</span>
            ) : (
              <span className="plan-diff-stats">
                <span className="plan-diff-stat-add">+{diffResult.added}</span>
                <span className="plan-diff-stat-del">−{diffResult.removed}</span>
              </span>
            )}
          </div>
          {diffResult.identical ? (
            <p className="muted plan-diff-empty">No changes between v{baseRevision.version} and v{viewingRevision.version}.</p>
          ) : (
            <div className="plan-diff-body" role="region" aria-label="Plan diff lines" tabIndex={0}>
              {diffResult.segments.map((seg, idx) =>
                seg.kind === "line" ? (
                  <DiffLineRow key={idx} line={seg.line} />
                ) : expandedRuns[idx] ? (
                  seg.lines.map((line, li) => <DiffLineRow key={`${idx}-${li}`} line={line} />)
                ) : (
                  <button
                    key={idx}
                    type="button"
                    className="plan-diff-collapsed"
                    onClick={() => setExpandedRuns((prev) => ({ ...prev, [idx]: true }))}
                  >
                    Show {seg.lines.length} unchanged lines
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ) : (
        <div
          className="plan-reading"
          data-plan-commentable={isCommentable ? "true" : "false"}
          data-plan-task-id={task.id}
          data-plan-revision-id={viewingRevision.id}
        >
          {isCommentable ? (
            <p className="plan-hint muted">
              Select any passage below and click <strong>Comment</strong> to attach inline feedback to v{viewingRevision.version}.
            </p>
          ) : null}

          <section className="plan-section" data-plan-section="Contract">
            <h3 className="plan-section-heading">Contract</h3>
            <Markdown text={viewingRevision.contract} className="body-text" />
          </section>

          <div className="plan-subtasks">
            <h3 className="plan-section-heading">Sub-tasks ({viewingRevision.subtasks.length})</h3>
            {viewingRevision.subtasks.map((sub, i) => (
              <section
                key={`${sub.repo}-${i}`}
                className="plan-section plan-subtask-card"
                data-plan-section={`Sub-task: ${sub.repo} — ${sub.title}`}
                data-plan-repo={sub.repo}
              >
                <h4 className="plan-subtask-heading">
                  <span>{i + 1}. {sub.title}</span>
                  <code className="plan-repo-pill">{sub.repo}</code>
                </h4>
                <Markdown text={sub.prompt} className="body-text" />
              </section>
            ))}
          </div>
        </div>
      )}

      {allReviews.length > 0 ? (
        <details className="context-drawer plan-reviews-drawer">
          <summary>
            Previous feedback ({revisionReviews.length > 0 ? `${revisionReviews.length} on v${viewingRevision.version}, ` : ""}{allReviews.length} total)
          </summary>
          <div className="plan-reviews-list">
            {allReviews.map((rev) => {
              const targetRev = revisions.find((r) => r.id === rev.revision_id);
              return (
                <div key={rev.id} className="plan-review-entry">
                  <div className="plan-review-meta">
                    <strong>On v{targetRev?.version ?? "?"}</strong>
                    <span className="muted">{formatTs(rev.created_ms)}</span>
                  </div>
                  {rev.note ? <p className="plan-review-note">{rev.note}</p> : null}
                  {rev.comments.length > 0 ? (
                    <ol className="plan-review-comments">
                      {rev.comments.map((c, ci) => (
                        <li key={ci} className="plan-review-comment">
                          <div className="plan-comment-section">{c.section}</div>
                          <blockquote className="plan-comment-quote">{c.quote}</blockquote>
                          <p className="plan-comment-body">{c.body}</p>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      {isOpen && !isApproved ? (
        <section className="plan-draft-panel" aria-label="Request plan changes">
          <h3 className="plan-draft-title">
            Request changes{viewingRevision ? ` (v${viewingRevision.version})` : ""}
          </h3>

          {isHandling ? (
            <p className="inline-ok" role="status">
              Changes were sent to the agent. Waiting for a revised plan to arrive.
            </p>
          ) : null}

          {draft.comments.length > 0 ? (
            <ul className="plan-comment-list">
              {draft.comments.map((c, idx) => {
                const inputId = `${noteId}-comment-${c.id}`;
                return (
                  <li key={c.id} className="plan-comment-card">
                    <div className="plan-comment-head">
                      <span className="plan-comment-section">
                        {c.section}
                        {c.repo ? <code className="plan-repo-pill">{c.repo}</code> : null}
                      </span>
                      <button
                        type="button"
                        className="btn plan-comment-remove"
                        aria-label={`Remove comment ${idx + 1} on ${c.section}`}
                        onClick={() =>
                          updateDraft((prev) => ({
                            ...prev,
                            comments: prev.comments.filter((entry) => entry.id !== c.id),
                          }))
                        }
                      >
                        Remove
                      </button>
                    </div>
                    <blockquote className="plan-comment-quote">{c.quote}</blockquote>
                    <label className="plan-comment-label" htmlFor={inputId}>
                      Your feedback
                    </label>
                    <textarea
                      id={inputId}
                      ref={(el) => {
                        commentRefs.current[c.id] = el;
                      }}
                      className="reply-input plan-comment-input"
                      rows={2}
                      placeholder="Explain what should change in this section…"
                      value={c.body}
                      disabled={submitBusy || isHandling}
                      onChange={(e) => {
                        const value = e.target.value;
                        updateDraft((prev) => ({
                          ...prev,
                          comments: prev.comments.map((entry) =>
                            entry.id === c.id ? { ...entry, body: value } : entry,
                          ),
                        }));
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}

          <label className="plan-note-label" htmlFor={noteId}>
            General note (optional)
          </label>
          <textarea
            id={noteId}
            className="reply-input"
            rows={3}
            placeholder="Overall feedback for the spec agent…"
            value={draft.note}
            disabled={submitBusy || isHandling}
            onChange={(e) => {
              const value = e.target.value;
              updateDraft((prev) => ({ ...prev, note: value }));
            }}
          />

          <div className="reply-foot">
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitBusy || isHandling || !hasSubmitContent}
              onClick={() => void submitRequestChanges()}
            >
              {submitBusy ? <Spinner /> : null}
              {submitBusy ? "Sending…" : "Request changes"}
            </button>
            {incompleteComments > 0 ? (
              <span className="muted">
                {incompleteComments} draft {incompleteComments === 1 ? "comment has" : "comments have"} no note yet.
              </span>
            ) : null}
            {submitOk ? <span className="inline-ok" role="status">{submitOk}</span> : null}
            {submitError ? <span className="inline-error" role="alert">{submitError}</span> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
