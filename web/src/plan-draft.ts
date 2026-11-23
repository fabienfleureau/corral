// Client-side draft store for multi-repo plan annotations, keyed by
// (task_id, revision_id) so drafts survive reloads and stay isolated per
// revision across browser tabs. Pure helpers stay testable without a browser.

export type PlanDraftComment = {
  id: string;
  revision_id: string;
  section: string;
  repo: string | null;
  quote: string;
  body: string;
};

export type PlanDraft = {
  note: string;
  comments: PlanDraftComment[];
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function planDraftKey(taskId: string, revisionId: string): string {
  return `corral.planDraft.${taskId}.${revisionId}`;
}

export function emptyPlanDraft(): PlanDraft {
  return { note: "", comments: [] };
}

export function hasPlanDraftContent(draft: PlanDraft): boolean {
  return draft.note.trim().length > 0 || draft.comments.length > 0;
}

export function loadPlanDraft(storage: StorageLike | null | undefined, taskId: string, revisionId: string): PlanDraft {
  if (!storage || !taskId || !revisionId) return emptyPlanDraft();
  try {
    const raw = storage.getItem(planDraftKey(taskId, revisionId));
    if (!raw) return emptyPlanDraft();
    const parsed = JSON.parse(raw) as Partial<PlanDraft>;
    const note = typeof parsed?.note === "string" ? parsed.note : "";
    const comments = Array.isArray(parsed?.comments)
      ? parsed.comments
          .filter((c): c is PlanDraftComment =>
            Boolean(c && typeof c === "object" && typeof c.id === "string" && typeof c.section === "string" && typeof c.quote === "string" && typeof c.body === "string"),
          )
          .map((c) => ({
            id: c.id,
            revision_id: typeof c.revision_id === "string" ? c.revision_id : revisionId,
            section: c.section,
            repo: typeof c.repo === "string" ? c.repo : null,
            quote: c.quote,
            body: c.body,
          }))
      : [];
    return { note, comments };
  } catch {
    return emptyPlanDraft();
  }
}

export function savePlanDraft(storage: StorageLike | null | undefined, taskId: string, revisionId: string, draft: PlanDraft): void {
  if (!storage || !taskId || !revisionId) return;
  try {
    if (!hasPlanDraftContent(draft)) {
      storage.removeItem(planDraftKey(taskId, revisionId));
      return;
    }
    storage.setItem(planDraftKey(taskId, revisionId), JSON.stringify(draft));
  } catch {
    /* localStorage may be unavailable or full */
  }
}

export function clearPlanDraft(storage: StorageLike | null | undefined, taskId: string, revisionId: string): void {
  if (!storage || !taskId || !revisionId) return;
  try {
    storage.removeItem(planDraftKey(taskId, revisionId));
  } catch {
    /* ignore */
  }
}

/** Custom event payload dispatched from SelectionToTask when clicking "Comment". */
export type PlanCommentRequest = {
  taskId: string;
  revisionId: string;
  section: string;
  repo: string | null;
  quote: string;
};

export const PLAN_COMMENT_EVENT = "corral:plan-comment";
