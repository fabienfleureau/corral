// Ideas — deliberately plain capture surface.

import { useEffect, useState } from "react";
import { api } from "../api";
import type { Idea } from "../types";
import { errText, formatTs, timeAgo } from "../util";
import { Spinner } from "../ui";

type StatusFilter = "all" | Idea["status"];
type TagFilter = "all" | Idea["tag"];

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "promoted", label: "Promoted" },
  { key: "dismissed", label: "Dismissed" },
];

const TAG_FILTERS: { key: TagFilter; label: string }[] = [
  { key: "all", label: "Any tag" },
  { key: "workflow", label: "workflow" },
  { key: "product", label: "product" },
];

export function IdeasPage({ eventVersion, refresh }: { eventVersion: number; refresh: () => void }) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [tagFilter, setTagFilter] = useState<TagFilter>("all");

  const [text, setText] = useState("");
  const [tag, setTag] = useState<Idea["tag"]>("workflow");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listIdeas()
      .then((list) => {
        if (!cancelled) {
          setIdeas(list);
          setError(null);
        }
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
  }, [eventVersion]);

  const capture = async () => {
    if (!text.trim() || captureBusy) return;
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const idea = await api.createIdea({ text: text.trim(), tag });
      setIdeas((prev) => [idea, ...prev]);
      setText("");
      refresh();
    } catch (err) {
      setCaptureError(errText(err));
    } finally {
      setCaptureBusy(false);
    }
  };

  const promote = async (idea: Idea) => {
    if (busyId) return;
    setBusyId(idea.id);
    setRowError(null);
    try {
      await api.createTask({ title: idea.text });
      await api.patchIdea(idea.id, { status: "promoted" });
      setIdeas((prev) => prev.map((i) => (i.id === idea.id ? { ...i, status: "promoted" } : i)));
      refresh();
    } catch (err) {
      setRowError(errText(err));
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (idea: Idea) => {
    if (busyId) return;
    setBusyId(idea.id);
    setRowError(null);
    try {
      await api.patchIdea(idea.id, { status: "dismissed" });
      setIdeas((prev) => prev.map((i) => (i.id === idea.id ? { ...i, status: "dismissed" } : i)));
      refresh();
    } catch (err) {
      setRowError(errText(err));
    } finally {
      setBusyId(null);
    }
  };

  const visible = ideas.filter(
    (i) => (statusFilter === "all" || i.status === statusFilter) && (tagFilter === "all" || i.tag === tagFilter),
  );

  return (
    <div className="page ideas-page">
      <div className="page-scroll">
        <div className="page-toolbar">
          <h1 className="page-title">Ideas</h1>
        </div>

        <div className="panel-form capture-box">
          <textarea
            rows={2}
            placeholder="Capture an idea — product, workflow, anything…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void capture();
            }}
          />
          <div className="form-foot">
            <select
              className="tag-select"
              value={tag}
              onChange={(e) => setTag(e.target.value as Idea["tag"])}
            >
              <option value="workflow">workflow</option>
              <option value="product">product</option>
            </select>
            <button className="btn btn-primary" onClick={() => void capture()} disabled={captureBusy || !text.trim()}>
              {captureBusy ? <Spinner /> : null}
              Capture
            </button>
            {captureError ? <span className="inline-error">{captureError}</span> : null}
          </div>
        </div>

        <div className="filter-bar">
          <div className="chip-row">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                className={`chip ${statusFilter === f.key ? "chip-active" : ""}`}
                onClick={() => setStatusFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="chip-row">
            {TAG_FILTERS.map((f) => (
              <button
                key={f.key}
                className={`chip ${tagFilter === f.key ? "chip-active" : ""}`}
                onClick={() => setTagFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {error ? <div className="inline-error">{error}</div> : null}
        {rowError ? <div className="inline-error">{rowError}</div> : null}

        {loading && ideas.length === 0 ? (
          <div className="pane-note">
            <Spinner label="Loading…" />
          </div>
        ) : visible.length === 0 ? (
          <div className="pane-note">Nothing captured here.</div>
        ) : (
          <div className="idea-list">
            {visible.map((idea) => (
              <div className="idea-row" key={idea.id}>
                <div className="idea-text">{idea.text}</div>
                <div className="idea-meta">
                  <span className={`chip chip-static tag-${idea.tag}`}>{idea.tag}</span>
                  <span className="chip chip-static origin-${idea.origin}">{idea.origin === "user" ? "you" : "agent"}</span>
                  <span className="chip chip-static status-${idea.status}">{idea.status}</span>
                  <span className="time muted" title={formatTs(idea.created_ms)}>
                    {timeAgo(idea.created_ms)}
                  </span>
                </div>
                <div className="idea-actions">
                  {idea.status !== "promoted" ? (
                    <button className="btn" onClick={() => void promote(idea)} disabled={busyId !== null}>
                      {busyId === idea.id ? <Spinner /> : null}
                      Promote to task
                    </button>
                  ) : null}
                  {idea.status !== "dismissed" ? (
                    <button className="btn" onClick={() => void dismiss(idea)} disabled={busyId !== null}>
                      Dismiss
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
