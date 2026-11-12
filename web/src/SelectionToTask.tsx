// Select text anywhere in the app — a report body in the inbox, most of the
// time — and a "New task" action appears next to it. It opens the Tasks page
// with the selection as the prompt, so a passage worth acting on becomes a
// dispatch in two clicks.

import { useCallback, useEffect, useState } from "react";
import { isTaskSelection, promptFromSelection, selectionTaskHash } from "./selection-task";

type Anchor = { text: string; top: number; left: number };

/** Room the pill needs above the selection before it flips below it. */
const PILL_HEIGHT = 44;
/** Half the pill's width, kept off the viewport edges. */
const EDGE = 110;

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
  return { text, left, top: above >= 8 ? above : rect.bottom + 10 };
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

  if (!anchor) return null;
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
