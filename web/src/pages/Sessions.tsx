// Sessions — live view of the agent terminals Corral is tracking.

import { useEffect, useState } from "react";
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

export function SessionsPage({ eventVersion }: { eventVersion: number }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState<string | null>(null);
  const [attachCmd, setAttachCmd] = useState<{ address: string; cmd: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listSessions()
      .then((list) => {
        if (!cancelled) {
          setSessions(list);
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

  const open = async (address: string) => {
    if (openBusy) return;
    setOpenBusy(address);
    setAttachCmd(null);
    try {
      const res = await api.openSession(address);
      if (!res.opened && res.attach_command) setAttachCmd({ address, cmd: res.attach_command });
    } catch (err) {
      setError(errText(err));
    } finally {
      setOpenBusy(null);
    }
  };

  return (
    <div className="page sessions-page">
      <div className="page-scroll">
        <div className="page-toolbar">
          <h1 className="page-title">Sessions</h1>
          <span className="muted">{sessions.filter((s) => s.state === "live").length} live</span>
        </div>

        {error ? <div className="inline-error">{error}</div> : null}
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
                    <button className="btn btn-primary" onClick={() => void open(s.address)} disabled={openBusy !== null}>
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
