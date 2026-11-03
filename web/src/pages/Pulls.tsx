// Pull Requests — where the human is awaited: review requested, or authored by
// them (how agent-created PRs show up). Color is the review signal.

import { useEffect, useState } from "react";
import { api } from "../api";
import type { Pull, PullColor } from "../types";
import { errText, formatTs, timeAgo } from "../util";
import { ExternalLinkIcon, Spinner } from "../ui";

const COLOR_LABEL: Record<PullColor, string> = {
  green: "green",
  orange: "pending",
  red: "failing",
};

export function PullsPage({ eventVersion }: { eventVersion: number }) {
  const [pulls, setPulls] = useState<Pull[]>([]);
  const [fetchedMs, setFetchedMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await api.listPulls();
      setPulls(res.pulls);
      setFetchedMs(res.fetched_ms);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, [eventVersion]);

  return (
    <div className="page pulls-page">
      <div className="page-scroll">
        <div className="page-toolbar">
          <h1 className="page-title">Pull Requests</h1>
          <div className="toolbar-actions">
            <span className="muted">
              {fetchedMs ? `updated ${timeAgo(fetchedMs)}` : "never fetched"}
            </span>
            <button className="btn" onClick={() => void load(true)} disabled={refreshing}>
              {refreshing ? <Spinner /> : null}
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {error ? <div className="inline-error">{error}</div> : null}
        {loading && pulls.length === 0 ? (
          <div className="pane-note">
            <Spinner label="Loading…" />
          </div>
        ) : pulls.length === 0 ? (
          <div className="pane-note">Nothing awaits you. PRs where you are reviewer or author appear here.</div>
        ) : (
          <div className="pull-list">
            {pulls.map((p) => (
              <div key={p.id} className={`pull-row pull-${p.color}`}>
                <span className={`dot dot-${p.color}`} title={p.reason} />
                <div className="pull-main">
                  <div className="pull-title">
                    <span className={`badge badge-${p.host === "github" ? "mute" : "target"}`}>{p.host}</span>
                    <a href={p.url} target="_blank" rel="noreferrer" className="pull-link">
                      {p.title}
                      <ExternalLinkIcon />
                    </a>
                    {p.state === "draft" ? <span className="badge badge-wait">draft</span> : <span className="badge">open</span>}
                    {p.isMine ? <span className="badge badge-mine">you are author</span> : <span className="badge badge-mute">author: {p.author}</span>}
                  </div>
                  <div className="pull-sub">
                    <span className="mono muted">{p.repo}</span>
                    <span className={`pull-status pull-${p.color}`}>{COLOR_LABEL[p.color]} — {p.reason}</span>
                    <span className="time muted" title={formatTs(p.updated_ms)}>
                      updated {timeAgo(p.updated_ms)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
