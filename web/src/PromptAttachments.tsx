// A prompt field that takes files: drop them on it, paste a screenshot, or pick
// them. The files are held by the parent and sent with the task (see
// attachments.ts for what is accepted).

import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, ReactNode } from "react";
import { addAttachments, formatBytes, MAX_ATTACHMENTS } from "./attachments";

/** Only a drag that carries files is ours: dragging selected text into the
 *  prompt must keep working. */
const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

function AttachmentChip({ file, disabled, onRemove }: { file: File; disabled: boolean; onRemove: () => void }) {
  const name = file.name || "image.png";
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <li className="attach-chip">
      {preview ? <img className="attach-thumb" src={preview} alt="" /> : null}
      <span className="attach-name" title={name}>{name}</span>
      <span className="muted">{formatBytes(file.size)}</span>
      <button type="button" className="attach-remove" aria-label={`Remove ${name}`} onClick={onRemove} disabled={disabled}>×</button>
    </li>
  );
}

export function PromptAttachments({ files, onChange, disabled = false, children }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean; children: ReactNode }) {
  const [dragging, setDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const picker = useRef<HTMLInputElement | null>(null);

  // A sent or emptied form must not keep last time's complaints.
  useEffect(() => {
    if (files.length === 0) setErrors([]);
  }, [files.length]);

  const add = (incoming: File[]) => {
    if (disabled || incoming.length === 0) return;
    const next = addAttachments(files, incoming);
    setErrors(next.errors);
    if (next.files.length !== files.length) onChange(next.files);
  };

  const onDrag = (e: DragEvent) => {
    if (disabled || !carriesFiles(e)) return;
    // Without this the browser opens the dropped file instead of handing it over.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    // Moving over a child (the textarea) also fires dragleave on the wrapper.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    add(Array.from(e.dataTransfer.files));
  };
  // Copying cells from a spreadsheet puts text and an image on the clipboard:
  // the text is what was meant, so files are taken only when there is none.
  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length === 0 || e.clipboardData.getData("text/plain")) return;
    e.preventDefault();
    add(pasted);
  };

  return (
    <div
      className={`prompt-drop${dragging ? " is-dragging" : ""}`}
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      {children}
      <div className="attach-bar">
        <button type="button" className="btn" onClick={() => picker.current?.click()} disabled={disabled || files.length >= MAX_ATTACHMENTS}>
          Attach files…
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            // Picking the same file again must fire change again.
            e.target.value = "";
          }}
        />
        <span className="muted form-hint">
          {dragging ? "Drop to attach" : "or drop files on the prompt, or paste a screenshot. Images, PDF, text and code."}
        </span>
      </div>
      {errors.length ? (
        <div className="inline-error" role="alert">
          {errors.map((message) => <div key={message}>{message}</div>)}
        </div>
      ) : null}
      {files.length ? (
        <>
          <span className="muted attach-count" role="status">{files.length} {files.length === 1 ? "file" : "files"} attached</span>
          <ul className="attach-list" aria-label="Attached files">
            {files.map((file) => (
              <AttachmentChip key={`${file.name}-${file.size}-${file.lastModified}`} file={file} disabled={disabled} onRemove={() => onChange(files.filter((f) => f !== file))} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
