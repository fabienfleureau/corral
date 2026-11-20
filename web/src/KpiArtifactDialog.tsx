// Native modal: the browser owns focus containment, top layer and Esc. The
// request is a form: the operator picks a format and the angles to cover.

import { useEffect, useId, useRef, useState } from "react";
import { ARTIFACT_AXES, ARTIFACT_FORMATS, DEFAULT_ARTIFACT_AXES, type ArtifactAxisId, type ArtifactFormat } from "../../shared/kpi-artifact";
import type { KpiId } from "../../shared/kpis";
import { api } from "./api";
import { taskFocusHash } from "./selection-task";
import { errText } from "./util";

const FORMAT_LABELS: Record<ArtifactFormat, { title: string; detail: string }> = {
  "one-page": { title: "One pager", detail: "A single page to share or print before the meeting." },
  slides: { title: "Slides", detail: "A short deck with speaker notes to present live." },
};

export function KpiArtifactDialog({ id, metricName, onClose }: {
  id: KpiId; metricName: string; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingId = useId();
  const audienceId = useId();
  const [format, setFormat] = useState<ArtifactFormat>("one-page");
  const [axes, setAxes] = useState<ArtifactAxisId[]>(() => DEFAULT_ARTIFACT_AXES as ArtifactAxisId[]);
  const [audience, setAudience] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [taskId, setTaskId] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const toggle = (axis: ArtifactAxisId) => setAxes((current) =>
    current.includes(axis) ? current.filter((value) => value !== axis) : [...current, axis]);

  const build = async () => {
    setBusy(true); setError(""); setTaskId("");
    try {
      const result = await api.buildKpiArtifact(id, {
        format,
        axes: ARTIFACT_AXES.filter((axis) => axes.includes(axis.id)).map((axis) => axis.id),
        audience,
      });
      setTaskId(result.task.id);
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  };

  return <dialog
    ref={dialogRef}
    className="artifact-dialog"
    aria-labelledby={headingId}
    onClose={onClose}
  >
    <form onSubmit={(event) => { event.preventDefault(); void build(); }}>
      <div className="history-head">
        <div>
          <h2 id={headingId} className="history-title">Build team artifact</h2>
          <p className="history-sub">{metricName} · private Claude artifact</p>
        </div>
        <button type="button" className="btn" autoFocus onClick={() => dialogRef.current?.close()}>Close</button>
      </div>
      <div className="artifact-dialog-body">
        <p className="muted kpi-meta">Claude turns the saved KPI reports into an artifact and reports its link to your inbox. Nothing is shared publicly.</p>

        <fieldset className="artifact-fieldset">
          <legend className="field">Format</legend>
          <div className="artifact-format-grid">
            {ARTIFACT_FORMATS.map((option) => <label key={option} className="artifact-format">
              <input type="radio" name="artifact-format" value={option} checked={format === option}
                onChange={() => setFormat(option)} />
              <span><strong>{FORMAT_LABELS[option].title}</strong><small className="muted">{FORMAT_LABELS[option].detail}</small></span>
            </label>)}
          </div>
        </fieldset>

        <fieldset className="artifact-fieldset">
          <legend className="field">Sections</legend>
          <p className="muted kpi-meta">The first four tell the core story. Pick the extra angles the team needs.</p>
          <div className="artifact-axis-grid">
            {ARTIFACT_AXES.map((axis) => <label key={axis.id} className={`artifact-axis${axis.required ? " is-required" : ""}`}>
              <input type="checkbox" checked={axes.includes(axis.id)} disabled={axis.required || busy}
                onChange={() => toggle(axis.id)} />
              <span>{axis.label}{axis.required ? " (always)" : ""}</span>
              <small className="muted">{axis.brief}</small>
            </label>)}
          </div>
        </fieldset>

        <label className="field" htmlFor={audienceId}>
          Audience or emphasis (optional)
          <textarea id={audienceId} rows={2} maxLength={500} value={audience} disabled={busy}
            placeholder="e.g. weekly product sync, keep it high level"
            onChange={(event) => setAudience(event.target.value)} />
        </label>

        {error && <div className="inline-error" role="alert">{error}</div>}
        {taskId && <div className="inline-ok" role="status">
          Request sent. <a href={taskFocusHash(taskId)} onClick={() => dialogRef.current?.close()}>Open the task</a> to follow the artifact link when Claude reports it.
        </div>}
      </div>
      <div className="form-foot artifact-dialog-foot">
        <button type="button" className="btn" disabled={busy} onClick={() => dialogRef.current?.close()}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Building…" : "Build artifact"}</button>
      </div>
    </form>
  </dialog>;
}
