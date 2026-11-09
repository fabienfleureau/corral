// App shell — sidebar navigation, auth gate, live SSE updates + notifications.

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, api, setCacheStateHandler, setUnauthorizedHandler, subscribeEvents } from "./api";
import { errText } from "./util";
import { createNotificationTracker, sendDesktopNotification } from "./notifications";
import type { Item } from "./types";
import { useVisibleInboxItems } from "./use-visible-inbox-items";
import { Spinner } from "./ui";
import { rememberInboxItems, unseenInboxItems } from "./inbox-seen";
import { InboxPage } from "./pages/Inbox";
import { TasksPage } from "./pages/Tasks";
import { SessionsPage } from "./pages/Sessions";
import { PullsPage } from "./pages/Pulls";
import { SettingsPage } from "./pages/Settings";
import { BenchmarksPage } from "./pages/Benchmarks";
import { UsagePage } from "./pages/Usage";

type Tab = "inbox" | "tasks" | "pulls" | "sessions" | "usage" | "benchmarks" | "settings" | "errors";

const TABS: { key: Tab; label: string }[] = [
  { key: "inbox", label: "Inbox" },
  { key: "tasks", label: "Tasks" },
  { key: "pulls", label: "Pull Requests" },
  { key: "sessions", label: "Sessions" },
  { key: "usage", label: "Usage" },
  { key: "benchmarks", label: "Benchmarks" },
  { key: "settings", label: "Settings" },
  { key: "errors", label: "Errors" },
];

type Counts = { inbox: number; tasks: number; pulls: number; sessions: number; errors: number };

function tabFromHash(): Tab {
  const h = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return TABS.some((t) => t.key === h) ? (h as Tab) : "inbox";
}

export function App() {
  const [unauthorized, setUnauthorized] = useState(false);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [otherCounts, setCounts] = useState<Counts>({ inbox: 0, tasks: 0, pulls: 0, sessions: 0, errors: 0 });
  const [openItems, setOpenItems] = useState<Item[]>([]);
  const visibleOpenItems = useVisibleInboxItems(openItems);
  const counts = { ...otherCounts, inbox: visibleOpenItems.length };
  const [seenItems, setSeenItems] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("corral.seenInboxItems") || "[]");
      return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    } catch { return []; }
  });
  const markInboxSeen = useCallback((items: Item[]) => {
    setSeenItems((previous) => {
      const seen = rememberInboxItems(previous, items);
      try { localStorage.setItem("corral.seenInboxItems", JSON.stringify(seen)); } catch { /* Storage may be unavailable. */ }
      return seen;
    });
  }, []);
  const [eventVersion, setEventVersion] = useState(0);
  const [errors, setErrors] = useState<{ source: string; message: string; updated_ms: number }[]>([]);
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
        sendDesktopNotification(item.title, item.summary || item.body.slice(0, 120));
      }
      setEventVersion((v) => v + 1);
    });
    return close;
  }, []);

  // Sidebar open counts.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listItems({ status: "open" }), api.listTasks("open"), api.listSessions(), api.listPulls(), api.listErrors()])
      .then(([items, tasks, sessions, pullsRes, syncErrors]) => {
        if (!cancelled) {
          setErrors(syncErrors);
          setOpenItems(items);
          setCounts({
            errors: syncErrors.length,
            inbox: 0,
            tasks: tasks.length,
            pulls: pullsRes.pulls.filter((p) => p.color !== "green").length,
            sessions: sessions.filter((s) => s.state === "live").length,
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

  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = unseenInboxItems(visibleOpenItems, seenItems) ? "/favicon-inbox.svg" : "/favicon.svg";
  }, [visibleOpenItems, seenItems]);

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
            <a key={t.key} className="nav-item" href={omnigentUrl} target="_blank" rel="noreferrer" aria-label="Sessions (opens Omnigent in a new tab)" title="Open Omnigent in a new tab">
              <span className="nav-label">{t.label}<svg className="nav-external-icon" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 3h4v4M13 3 7 9" /><path d="M12 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></svg></span>
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
              {t.key !== "settings" && t.key !== "usage" && t.key !== "benchmarks" ? (
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
        {tab === "inbox" ? <InboxPage eventVersion={eventVersion} refresh={refresh} onSeen={markInboxSeen} /> : null}
        {tab === "tasks" ? <TasksPage eventVersion={eventVersion} refresh={refresh} /> : null}
        {tab === "pulls" ? <PullsPage eventVersion={eventVersion} /> : null}
        {tab === "sessions" ? <SessionsPage eventVersion={eventVersion} /> : null}
        {tab === "benchmarks" ? <BenchmarksPage /> : null}
        {tab === "usage" ? <UsagePage /> : null}
        {tab === "settings" ? <SettingsPage /> : null}
        {tab === "errors" ? <section><h1>Error center</h1><p className="muted">Current background synchronization errors. Errors clear after a successful refresh.</p>{errors.length === 0 ? <p>No current errors.</p> : errors.map((error) => <div className="inline-error" key={error.source}><strong>{error.source}</strong><p>{error.message}</p><small>{new Date(error.updated_ms).toLocaleString()}</small></div>)}</section> : null}
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
