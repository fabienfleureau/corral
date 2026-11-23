// Select text anywhere in the app — a report body in the inbox, most of the
// time — and a "New task" action appears next to it. Inside an active, open
// multi-repo plan's reading view, the pill also offers "Comment" to attach an
// inline annotation to the current plan revision.

import { useCallback, useEffect, useState } from "react";
import { isTaskSelection, promptFromSelection, selectionTaskHash } from "./selection-task";
import { PLAN_COMMENT_EVENT, type PlanCommentRequest } from "./plan-draft";

/**
 * Inspect a DOM selection to determine whether it starts and ends inside an
 * active, open plan's reading-view container (`[data-plan-commentable="true"]`).
 * Returns deterministic section/repo metadata or null outside commentable plans.
 */
function planCommentFromSelection(selection: Selection, quote: string): PlanCommentRequest | null {
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const endEl = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  if (!startEl || !endEl) return null;
  const startRoot = startEl.closest<HTMLElement>('[data-plan-commentable="true"]');
  const endRoot = endEl.closest<HTMLElement>('[data-plan-commentable="true"]');
  if (!startRoot || startRoot !== endRoot) return null;
  const taskId = startRoot.dataset.planTaskId ?? "";
  const revisionId = startRoot.dataset.planRevisionId ?? "";
  if (!taskId || !revisionId) return null;

  const sectionEl = startEl.closest<HTMLElement>("[data-plan-section]");
  let section = sectionEl?.dataset.planSection || "Contract";
  const repo = sectionEl?.dataset.planRepo || null;

  if (section === "Contract" && sectionEl) {
    const mdRoot = sectionEl.querySelector(".md");
    if (mdRoot) {
      const headings = Array.from(mdRoot.querySelectorAll("h2, h3, h4"));
      let nearest: string | null = null;
      for (const h of headings) {
        const pos = h.compareDocumentPosition(range.startContainer);
        if (h === range.startContainer || h.contains(range.startContainer) || (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
          const text = h.textContent?.trim();
          if (text) nearest = text;
        }
      }
      if (nearest) section = `Contract > ${nearest}`;
    }
  }

  return { taskId, revisionId, section, repo, quote };
}

type Anchor = {
  text: string;
  top: number;
  left: number;
  planComment: PlanCommentRequest | null;
};

/** Room the pill needs above the selection before it flips below it. */
const PILL_HEIGHT = 44;
/** Half the pill's width, kept off the viewport edges. */
const EDGE = 140;

function anchorFor(selection: Selection): Anchor | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = promptFromSelection(selection.toString());
  if (!isTaskSelection(text)) return null;
  // A selection inside a field is edit text, not a passage to quote.
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  if (element?.closest("input, textarea, select, [contenteditable='true']")) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const left = Math.min(Math.max(rect.left + rect.width / 2, EDGE), window.innerWidth - EDGE);
  const above = rect.top - PILL_HEIGHT;
  const planComment = planCommentFromSelection(selection, text);
  return { text, left, top: above >= 8 ? above : rect.bottom + 10, planComment };
}

export function SelectionToTask() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const selection = document.getSelection();
      setAnchor(selection ? anchorFor(selection) : null);
    };
    // selectionchange fires on every caret move while dragging: coalesce.
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    const dismiss = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      setAnchor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("mouseup", schedule);
    document.addEventListener("keyup", schedule);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", dismiss);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("mouseup", schedule);
      document.removeEventListener("keyup", schedule);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", dismiss);
    };
  }, []);

  const create = useCallback(() => {
    if (!anchor) return;
    document.getSelection()?.removeAllRanges();
    setAnchor(null);
    window.location.hash = selectionTaskHash(anchor.text);
  }, [anchor]);

  const comment = useCallback(() => {
    if (!anchor?.planComment) return;
    const detail = anchor.planComment;
    document.getSelection()?.removeAllRanges();
    setAnchor(null);
    window.dispatchEvent(new CustomEvent<PlanCommentRequest>(PLAN_COMMENT_EVENT, { detail }));
  }, [anchor]);

  if (!anchor) return null;
  if (anchor.planComment) {
    return (
      <div
        className="selection-task selection-task-group"
        role="toolbar"
        aria-label="Selection actions"
        style={{ top: anchor.top, left: anchor.left }}
        onMouseDown={(event) => event.preventDefault()}
      >
        <button
          type="button"
          className="selection-task-action"
          onClick={comment}
          title="Add a review comment on the selected passage"
        >
          Comment
        </button>
        <span className="selection-task-divider" aria-hidden="true" />
        <button
          type="button"
          className="selection-task-action"
          onClick={create}
          title="Create a task with the selected text as its prompt"
        >
          <span aria-hidden="true">+</span> New task
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="selection-task"
      style={{ top: anchor.top, left: anchor.left }}
      // Keep the selection alive until the click lands, then navigate.
      onMouseDown={(event) => event.preventDefault()}
      onClick={create}
      title="Create a task with the selected text as its prompt"
    >
      <span aria-hidden="true">+</span> New task
    </button>
  );
}
