// Viewer for local Markdown files referenced in task text. Like the task
// history, this is a native modal: the browser owns the top layer, focus,
// Esc and focus return, so none of that is reimplemented here.

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { Markdown } from "./markdown";
import { MarkdownFileContext } from "./markdown-file-context";
import { errText } from "./util";
import { Spinner } from "./ui";

function MarkdownFileDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingId = useId();
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    api.markdownFile(path)
      .then((result) => { if (!cancelled) setFile(result); })
      .catch((err: unknown) => { if (!cancelled) setError(errText(err)); });
    return () => { cancelled = true; };
  }, [path]);

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
  }, [path]);

  const name = path.split("/").at(-1) || path;
  return (
    <dialog
      ref={dialogRef}
      className="markdown-file-dialog"
      aria-labelledby={headingId}
      {...({ closedby: "any" } as Record<string, string>)}
      onClose={onClose}
    >
      <div className="history-head">
        <div>
          <h2 id={headingId} className="history-title">{name}</h2>
          <p className="history-sub" title={path}>{path}</p>
        </div>
        <button type="button" className="btn" autoFocus onClick={() => dialogRef.current?.close()}>Close</button>
      </div>
      <div className="markdown-file-body">
        {error ? <div className="inline-error">{error}</div> : null}
        {!error && !file ? <div className="pane-note"><Spinner label="Loading Markdown…" /></div> : null}
        {file ? <Markdown text={file.content} /> : null}
      </div>
    </dialog>
  );
}

export function MarkdownFileProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState<string | null>(null);
  return (
    <MarkdownFileContext.Provider value={setPath}>
      {children}
      {path ? <MarkdownFileDialog path={path} onClose={() => setPath(null)} /> : null}
    </MarkdownFileContext.Provider>
  );
}
