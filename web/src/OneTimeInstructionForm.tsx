import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { errText } from "./util";

export function OneTimeInstructionForm({
  idPrefix,
  resetKey,
  headingLevel = "h2",
  helpText,
  placeholder,
  busy,
  running,
  canRun,
  disabledReason,
  onSend,
}: {
  idPrefix: string;
  resetKey?: string;
  headingLevel?: "h2" | "h4";
  helpText: string;
  placeholder: string;
  busy: boolean;
  running: boolean;
  canRun: boolean;
  disabledReason?: string;
  onSend: (instruction: string) => Promise<void>;
}) {
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setInstruction("");
    setError("");
    setNotice("");
  }, [resetKey]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed) {
      setError("Enter a one-time instruction for the agent.");
      inputRef.current?.focus();
      return;
    }
    setSending(true);
    setError("");
    setNotice("");
    try {
      await onSend(trimmed);
      setInstruction("");
      setNotice("Sent for this run — cycle started.");
    } catch (err) {
      setError(errText(err));
    } finally {
      setSending(false);
    }
  };

  const titleId = `${idPrefix}-title`;
  const inputId = `${idPrefix}-input`;
  const helpId = `${idPrefix}-help`;
  const Heading = headingLevel;
  const locked = sending || busy || running;

  return (
    <form
      className="panel-form agent-instruction"
      aria-labelledby={titleId}
      onSubmit={(event) => void submit(event)}
    >
      <Heading id={titleId} className="panel-title">One-time instruction</Heading>
      <div className="field">
        <label htmlFor={inputId}>Instruction for the next run</label>
        <textarea
          ref={inputRef}
          id={inputId}
          name="instruction"
          rows={3}
          maxLength={6000}
          required
          value={instruction}
          disabled={locked}
          placeholder={placeholder}
          aria-describedby={helpId}
          aria-invalid={error ? "true" : undefined}
          onChange={(event) => {
            setInstruction(event.target.value);
            if (error) setError("");
            if (notice) setNotice("");
          }}
        />
        <small id={helpId} className="muted kpi-meta">{helpText}</small>
      </div>
      {disabledReason && !running && <p className="muted kpi-meta">{disabledReason}</p>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <p className="muted kpi-meta" role="status">{notice}</p>}
      <div className="form-foot">
        <button type="submit" className="btn btn-primary" disabled={locked || !canRun}>
          {sending ? "Sending…" : "Send & run"}
        </button>
      </div>
    </form>
  );
}
