// Interview round in a native modal. The browser owns focus, Esc, the top
// layer and focus return, so the card can keep its carousel behaviour without
// pushing the rest of the inbox detail pane down.

import { useEffect, useId, useRef } from "react";
import type { GrillQuestion } from "./grill-format";
import { GrillRoundReply } from "./GrillRoundReply";

export function GrillRoundDialog({ questions, title, disabled, error, onSend, onClose }: {
  questions: GrillQuestion[];
  title: string;
  disabled: boolean;
  error: string | null;
  onSend: (answers: Record<string, string | string[]>) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // `closedby` is not in Safari yet. Check pointer position, not target:
    // the dialog is also the target for its padding and child gaps.
    if ("closedBy" in HTMLDialogElement.prototype) return;
    let pressedOutside = false;
    const outside = (ev: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom;
    };
    const down = (ev: PointerEvent) => { pressedOutside = outside(ev); };
    const up = (ev: PointerEvent) => { if (pressedOutside && outside(ev)) dialog.close(); };
    dialog.addEventListener("pointerdown", down);
    dialog.addEventListener("pointerup", up);
    return () => {
      dialog.removeEventListener("pointerdown", down);
      dialog.removeEventListener("pointerup", up);
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="grill-dialog"
      aria-labelledby={headingId}
      {...({ closedby: "any" } as Record<string, string>)}
      onClose={onClose}
    >
      <div className="history-head">
        <div>
          <h2 id={headingId} className="history-title">Interview questions</h2>
          <p className="history-sub" title={title}>{title}</p>
        </div>
        <button type="button" className="btn" autoFocus onClick={() => dialogRef.current?.close()}>Close</button>
      </div>
      <div className="history-body">
        <GrillRoundReply questions={questions} disabled={disabled} onSend={onSend} />
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
      </div>
    </dialog>
  );
}
