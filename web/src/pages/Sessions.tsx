// Sessions — live view of the agent terminals Corral is tracking,
// plus scheduled/manual diagnosis and cleanup of orphaned Corral sessions.

import { useCallback, useEffect, useState } from "react";
import {
  SESSION_CLEANUP_REASON_LABELS,
  type SessionCleanupAction,
  type SessionCleanupReason,
  type SessionCleanupStatus,
} from "../../../shared/session-cleanup";
import { api } from "../api";
import type { SessionInfo } from "../types";
import { errText, formatTs, timeAgo } from "../util";
import { Spinner } from "../ui";

const STATUS_LABEL: Record<string, string> = {
  working: "working",
  blocked: "needs you",
  idle: "idle",
  done: "done",
  error: "error",
};

const ACTION_LABEL: Record<SessionCleanupAction, string> = {
  archived: "archived",
  worktree_cleaned: "worktree cleaned",
  killed: "killed",
  would_clean: "would clean",
  failed: "failed",
  warning: "warning",
};

export function SessionsPage({ eventVersion }: { eventVersion: number }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [cleanup, setCleanup] = useState<SessionCleanupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState<string | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState<"analyze" | "clean" | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [attachCmd, setAttachCmd] = useState<{ address: string; cmd: string } | null>(null);

  const loadAll = useCallback(async () => {
    const [listRes, cleanupRes] = await Promise.allSettled([
      api.listSessions(),
      api.getSessionCleanup(),
    ]);
    if (listRes.status === "fulfilled") {
      setSessions(listRes.value);
      setError(null);
    } else {
      setError(errText(listRes.reason));
    }
    if (cleanupRes.status === "fulfilled") {
      setCleanup(cleanupRes.value);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadAll().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [eventVersion, loadAll]);

  const open = async (address: string) => {
    if (openBusy) return;
    setOpenBusy(address);
    setAttachCmd(null);
    try {
      const res = await api.openSession(address);
      if (res.url) window.open(res.url, "_blank", "noopener");
    } catch (err) {
      setError(errText(err));
    } finally {
      setOpenBusy(null);
    }
  };

  const runCleanup = async (dryRun: boolean) => {
    if (cleanupBusy) return;
    setCleanupBusy(dryRun ? "analyze" : "clean");
    setError(null);
    try {
      await api.runSessionCleanup({ dryRun });
      setDetailsOpen(true);
      await loadAll();
    } catch (err) {
      setError(errText(err));
    } finally {
      setCleanupBusy(null);
    }
  };

  const lastRun = cleanup?.lastRun ?? null;
  const reasonEntries = lastRun
    ? (Object.entries(lastRun.by_reason) as [SessionCleanupReason, number][]).filter(([, n]) => n > 0)
    : [];

  return (
    <div className="page sessions-page">
      <div className="page-scroll">
        <div className="page-toolbar">
          <h1 className="page-title">Sessions</h1>
          <span className="muted">{sessions.filter((s) => s.state === "live").length} live</span>
          {cleanup ? (
            <span className="muted">
              {cleanup.config.enabled
                ? `Auto-cleanup every ${cleanup.config.intervalMinutes}m`
                : "Auto-cleanup off"}
            </span>
          ) : null}
          <div className="session-toolbar-actions">
            <button
              type="button"
              className="btn"
              onClick={() => void runCleanup(true)}
              disabled={cleanupBusy !== null}
            >
              {cleanupBusy === "analyze" ? <Spinner /> : null}
              {cleanupBusy === "analyze" ? "Analyzing…" : "Analyze"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runCleanup(false)}
              disabled={cleanupBusy !== null}
            >
              {cleanupBusy === "clean" ? <Spinner /> : null}
              {cleanupBusy === "clean" ? "Cleaning…" : "Clean up orphans"}
            </button>
          </div>
        </div>

        {error ? <div className="inline-error">{error}</div> : null}

        {lastRun ? (
          <article className="session-cleanup-card" aria-label="Session cleanup and diagnosis">
            <header className="session-cleanup-summary">
              <div className="session-cleanup-title">
                <strong>Session cleanup &amp; diagnosis</strong>
                <span className="badge badge-mute">
                  {lastRun.dry_run ? "dry-run" : lastRun.trigger}
                </span>
                <span className="muted" title={formatTs(lastRun.ran_ms)}>
                  Last run {timeAgo(lastRun.ran_ms)}
                </span>
              </div>
              <div className="session-cleanup-counts muted">
                <span>{lastRun.scanned} scanned</span>
                <span>{lastRun.kept_active} active</span>
                <span>
                  {lastRun.dry_run
                    ? `${lastRun.would_clean} would clean`
                    : `${lastRun.cleaned} cleaned`}
                </span>
                {lastRun.external_ignored > 0 ? (
                  <span>{lastRun.external_ignored} external ignored</span>
                ) : null}
                {lastRun.warnings > 0 ? <span>{lastRun.warnings} warnings</span> : null}
                {lastRun.failed > 0 ? <span>{lastRun.failed} failed</span> : null}
              </div>
            </header>

            {reasonEntries.length > 0 ? (
              <div className="session-cleanup-reasons">
                {reasonEntries.map(([reason, count]) => (
                  <span key={reason} className="badge badge-mute">
                    {SESSION_CLEANUP_REASON_LABELS[reason] ?? reason}: {count}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted session-cleanup-empty">No orphaned sessions detected in this scan.</p>
            )}

            {lastRun.items.length > 0 ? (
              <details
                className="session-cleanup-details"
                open={detailsOpen}
                onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
              >
                <summary>Diagnosed sessions ({lastRun.items.length})</summary>
                <ul className="session-cleanup-items">
                  {lastRun.items.map((item) => (
                    <li key={`${item.address}-${item.reason}`} className="session-cleanup-item">
                      <div className="session-cleanup-item-main">
                        <strong>{item.task_title ?? item.name ?? item.address}</strong>
                        <span className="mono muted">{item.address}</span>
                        <span className="badge badge-mute">
                          {SESSION_CLEANUP_REASON_LABELS[item.reason] ?? item.reason}
                        </span>
                        <span
                          className={`badge ${
                            item.action === "failed"
                              ? "status-error"
                              : item.action === "warning"
                                ? "status-blocked"
                                : "status-done"
                          }`}
                        >
                          {ACTION_LABEL[item.action] ?? item.action}
                        </span>
                      </div>
                      <div className="session-cleanup-item-detail muted">
                        {item.detail}
                        {item.error ? ` (${item.error})` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </article>
        ) : null}

        {loading && sessions.length === 0 ? (
          <div className="pane-note">
            <Spinner label="Loading…" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="pane-note">No agent sessions yet — dispatch a task to start one.</div>
        ) : (
          <div className="session-list">
            {sessions.map((s) => {
              const status = s.status ?? "";
              const live = s.state === "live";
              return (
                <div key={s.address} className={`session-row ${status === "blocked" ? "needs-you" : ""}`}>
                  <div className="session-main">
                    <div className="session-title">
                      <span className={`badge status-${live ? status || "working" : "done"}`}>
                        {live ? STATUS_LABEL[status] ?? status ?? "running" : "finished"}
                      </span>
                      <strong>{s.task_title ?? s.name ?? s.address}</strong>
                      <span className="mono muted">{s.address}</span>
                      {s.agent ? <span className="badge badge-mute">{s.agent}</span> : null}
                    </div>
                    <div className="session-sub">
                      {s.cwd ? <span className="mono muted">{s.cwd}</span> : null}
                      <span className="muted">turn {s.turn}</span>
                      {s.exit_code !== null ? <span className="muted">exit {s.exit_code}</span> : null}
                      <span className="time muted" title={formatTs(s.created_ms)}>
                        started {timeAgo(s.created_ms)}
                      </span>
                    </div>
                  </div>
                  <div className="session-actions">
                    <button type="button" className="btn btn-primary" onClick={() => void open(s.address)} disabled={openBusy !== null}>
                      {openBusy === s.address ? <Spinner /> : null}
                      {openBusy === s.address ? "Opening…" : "Open conversation"}
                    </button>
                  </div>
                  {attachCmd?.address === s.address ? (
                    <div className="inline-ok">
                      Open it yourself: <code className="mono">{attachCmd.cmd}</code>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
