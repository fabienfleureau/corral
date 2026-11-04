// App shell — sidebar navigation, auth gate, live SSE updates + notifications.

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, api, setCacheStateHandler, setUnauthorizedHandler, subscribeEvents } from "./api";
import { errText } from "./util";
import { createNotificationTracker } from "./notifications";
import { Spinner } from "./ui";
import { InboxPage } from "./pages/Inbox";
import { TasksPage } from "./pages/Tasks";
import { SessionsPage } from "./pages/Sessions";
import { PullsPage } from "./pages/Pulls";
import { IdeasPage } from "./pages/Ideas";
import { SettingsPage } from "./pages/Settings";
import { UsagePage } from "./pages/Usage";

type Tab = "inbox" | "tasks" | "pulls" | "sessions" | "ideas" | "usage" | "settings";

const TABS: { key: Tab; label: string }[] = [
  { key: "inbox", label: "Inbox" },
  { key: "tasks", label: "Tasks" },
  { key: "pulls", label: "Pull Requests" },
  { key: "sessions", label: "Sessions" },
  { key: "ideas", label: "Ideas" },
  { key: "usage", label: "Usage" },
  { key: "settings", label: "Settings" },
];

type Counts = { inbox: number; tasks: number; pulls: number; sessions: number; ideas: number };

function tabFromHash(): Tab {
  const h = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return TABS.some((t) => t.key === h) ? (h as Tab) : "inbox";
}

export function App() {
  const [unauthorized, setUnauthorized] = useState(false);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [counts, setCounts] = useState<Counts>({ inbox: 0, tasks: 0, pulls: 0, sessions: 0, ideas: 0 });
  const [eventVersion, setEventVersion] = useState(0);
  const [bootError, setBootError] = useState<string | null>(null);
  const [omnigentUrl, setOmnigentUrl] = useState<string | null>(null);

  const refresh = useCallback(() => setEventVersion((v) => v + 1), []);

  // Hash routing: every page has a stable, shareable link (#/pulls, #/settings…).
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const selectTab = (t: Tab) => {
    window.location.hash = `/${t}`;
    setTab(t);
  };

  // Auth probe + global 401 handling.
  useEffect(() => {
    setUnauthorizedHandler(() => setUnauthorized(true));
    api
      .getConfig()
      .then((config) => {
        setOmnigentUrl(config.omnigentUrl || null);
        setBootError(null);
      })
      .catch((err: unknown) => {
        const status = err instanceof ApiError ? err.status : -1;
        if (status === 401) return; // handled by setUnauthorizedHandler
        setBootError(status === 0 ? "Cannot reach the Corral server." : errText(err));
      });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Live updates: one SSE connection feeds every page + desktop notifications.
  // PR items start unready and flip via item.updated once the gate passes.
  useEffect(() => {
    const trackNotification = createNotificationTracker();
    const close = subscribeEvents((event) => {
      const item = trackNotification(event);
      if (item) {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification(item.title, {
              body: item.summary || item.body.slice(0, 120),
            });
          } catch {
            /* notification construction can fail in some environments */
          }
        }
      }
      setEventVersion((v) => v + 1);
    });
    return close;
  }, []);

  // Sidebar open counts.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listItems({ status: "open" }), api.listTasks("open"), api.listIdeas("new"), api.listSessions(), api.listPulls()])
      .then(([items, tasks, ideas, sessions, pullsRes]) => {
        if (!cancelled) {
          setCounts({
            inbox: items.length,
            tasks: tasks.length,
            pulls: pullsRes.pulls.filter((p) => p.color !== "green").length,
            sessions: sessions.filter((s) => s.state === "live").length,
            ideas: ideas.length,
          });
        }
      })
      .catch(() => {
        /* 401 surfaces globally; other errors are non-fatal for counts */
      });
    return () => {
      cancelled = true;
    };
  }, [eventVersion]);

  // Offline mode: track connectivity (the service worker serves cached data).
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  // Online but the server answered from the worker's cache (unreachable/slow).
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setCacheStateHandler(setStale);
    return () => setCacheStateHandler(null);
  }, []);

  if (unauthorized) return <TokenScreen />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <span className="brand-name">Corral</span>
        </div>
        <nav className="nav">
          {TABS.map((t) => t.key === "sessions" && omnigentUrl ? (
            <a key={t.key} className="nav-item" href={omnigentUrl} target="_blank" rel="noreferrer">
              <span>{t.label}</span>
              <span className="nav-count">
                {counts.sessions}
              </span>
            </a>
          ) : (
            <button
              key={t.key}
              className={`nav-item ${tab === t.key ? "nav-active" : ""}`}
              onClick={() => selectTab(t.key)}
            >
              <span>{t.label}</span>
              {t.key !== "settings" && t.key !== "usage" ? (
                <span className={`nav-count ${t.key !== "sessions" && counts[t.key as keyof Counts] > 0 ? "nav-count-hot" : ""}`}>
                  {counts[t.key as keyof Counts]}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        {bootError ? <div className="sidebar-foot inline-error">{bootError}</div> : <div className="sidebar-foot muted">live</div>}
      </aside>
      <main className="content">
        {!online || stale ? (
          <div className="offline-banner">
            {online ? "Corral is unreachable" : "Offline"} — showing cached data. Actions
            will fail until the connection is back.
          </div>
        ) : null}
        {tab === "inbox" ? <InboxPage eventVersion={eventVersion} refresh={refresh} /> : null}
        {tab === "tasks" ? <TasksPage eventVersion={eventVersion} refresh={refresh} /> : null}
        {tab === "pulls" ? <PullsPage eventVersion={eventVersion} /> : null}
        {tab === "sessions" ? <SessionsPage eventVersion={eventVersion} /> : null}
        {tab === "ideas" ? <IdeasPage eventVersion={eventVersion} refresh={refresh} /> : null}
        {tab === "usage" ? <UsagePage /> : null}
        {tab === "settings" ? <SettingsPage /> : null}
      </main>
    </div>
  );
}

function TokenScreen() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    // The server sets the cookie and redirects back to "/".
    window.location.href = `/?token=${encodeURIComponent(value)}`;
  };

  return (
    <div className="token-screen">
      <form className="token-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">C</span>
          <span className="brand-name">Corral</span>
        </div>
        <p className="muted">Enter your Corral token to continue. It is stored as a cookie.</p>
        <label className="field">
          <span>Token</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="corral token"
            autoFocus
            autoComplete="off"
          />
        </label>
        <div className="form-foot">
          <button type="submit" className="btn btn-primary" disabled={busy || !token.trim()}>
            {busy ? <Spinner /> : null}
            {busy ? "Connecting…" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}
