// App shell — sidebar navigation, auth gate, live SSE updates + notifications.

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, api, setCacheStateHandler, setUnauthorizedHandler, subscribeEvents } from "./api";
import { errText } from "./util";
import { createNotificationTracker, sendDesktopNotification } from "./notifications";
import type { Item } from "./types";
import { useVisibleInboxItems } from "./use-visible-inbox-items";
import { Spinner } from "./ui";
import { SelectionToTask } from "./SelectionToTask";
import { MarkdownFileProvider } from "./MarkdownFileDialog";
import { openInboxItems } from "./inbox-selection";
import { rememberInboxItems, unseenInboxItems } from "./inbox-seen";
import { NavIcon } from "./nav-icons";
import { BrandMark } from "./BrandMark";
import { ResizeHandle } from "./ResizeHandle";
import { usePaneFlag, usePaneWidth } from "./use-pane-size";
import type { PaneLimits } from "./pane-size";
import { InboxPage } from "./pages/Inbox";
import { TasksPage } from "./pages/Tasks";
import { SessionsPage } from "./pages/Sessions";
import { EpicsPage } from "./pages/Epics";
import { PullsPage } from "./pages/Pulls";
import { SettingsPage } from "./pages/Settings";
import { UsagePage } from "./pages/Usage";
import { DailyPage } from "./pages/Daily";
import { ProgressPage, ProgressCelebration } from "./pages/Progress";
import { ImprovePage } from "./pages/Improve";

type Tab = "progress" | "daily" | "inbox" | "tasks" | "epics" | "pulls" | "sessions" | "usage" | "improve" | "settings" | "errors";

const TABS: { key: Tab; label: string }[] = [
  { key: "inbox", label: "Waiting" },
  { key: "tasks", label: "Tasks" },
  { key: "epics", label: "Epics" },
  { key: "daily", label: "Daily" },
  { key: "progress", label: "Progress" },
  { key: "pulls", label: "Pull Requests" },
  { key: "sessions", label: "Sessions" },
  { key: "usage", label: "Usage" },
  { key: "improve", label: "Improve" },
  { key: "settings", label: "Settings" },
  { key: "errors", label: "Errors" },
];

type Counts = { inbox: number; tasks: number; pulls: number; sessions: number; errors: number };

const SIDEBAR_LIMITS: PaneLimits = { min: 160, max: 360 };
const SIDEBAR_DEFAULT_WIDTH = 200;
/** The page next to the sidebar never gets squeezed below this. */
const CONTENT_MIN_WIDTH = 480;

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
  /** What actually asks the human for something: the agent is not handling it. */
  const openHumanItems = openInboxItems(visibleOpenItems);
  const counts = { ...otherCounts, inbox: openHumanItems.length };
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
  const [sidebarCollapsed, setSidebarCollapsed] = usePaneFlag("corral.sidebarCollapsed");
  const sidebarSize = usePaneWidth("corral.sidebarWidth", SIDEBAR_DEFAULT_WIDTH, SIDEBAR_LIMITS);

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
  // Bursts of events (an agent working emits several) are coalesced into one
  // refresh: every page and the sidebar counts refetch on the version bump, so
  // one bump per event turned agent activity into a request storm.
  useEffect(() => {
    const trackNotification = createNotificationTracker();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bumpSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setEventVersion((v) => v + 1);
      }, 250);
    };
    const close = subscribeEvents((event) => {
      const item = trackNotification(event);
      if (item) {
        sendDesktopNotification(item.title, item.summary || item.body.slice(0, 120));
      }
      bumpSoon();
    });
    return () => {
      if (timer) clearTimeout(timer);
      close();
    };
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
            pulls: pullsRes.pulls.filter((p) => p.awaitingMe && p.color !== "green").length,
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
    if (icon) icon.href = unseenInboxItems(openHumanItems, seenItems) ? "/favicon-inbox.svg" : "/favicon.svg";
  }, [openHumanItems, seenItems]);

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
    <MarkdownFileProvider>
    <div className="app">
      <aside
        className={`sidebar ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
        style={sidebarCollapsed ? undefined : { width: sidebarSize.width }}
      >
        <div className="brand">
          <BrandMark />
          <span className="brand-name">Corral</span>
          <button
            type="button"
            className="sidebar-toggle"
            aria-label="Show navigation labels"
            aria-pressed={!sidebarCollapsed}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
        </div>
        <nav className="nav" aria-label="Primary">
          {TABS.map((t) => {
            const count = counts[t.key as keyof Counts];
            const hasCount = t.key !== "progress" && t.key !== "daily" && t.key !== "settings" && t.key !== "usage" && t.key !== "improve";
            const countClass = `nav-count ${t.key !== "sessions" && count > 0 ? "nav-count-hot" : ""} ${count > 0 ? "" : "nav-count-zero"}`;
            return t.key === "sessions" && omnigentUrl ? (
              <a key={t.key} className="nav-item" href={omnigentUrl} target="_blank" rel="noreferrer" aria-label="Sessions (opens Omnigent in a new tab)" title="Open Omnigent in a new tab">
                <NavIcon name={t.key} />
                <span className="nav-label">{t.label}<svg className="nav-external-icon" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 3h4v4M13 3 7 9" /><path d="M12 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></svg></span>
                <span className={`nav-count ${counts.sessions > 0 ? "" : "nav-count-zero"}`}>{counts.sessions}</span>
              </a>
            ) : (
              <button
                key={t.key}
                className={`nav-item ${tab === t.key ? "nav-active" : ""}`}
                aria-current={tab === t.key ? "page" : undefined}
                title={sidebarCollapsed ? t.label : undefined}
                onClick={() => selectTab(t.key)}
              >
                <NavIcon name={t.key} />
                <span className="nav-label">{t.label}</span>
                {hasCount ? <span className={countClass}>{count}</span> : null}
              </button>
            );
          })}
        </nav>
        {bootError ? (
          <div className="sidebar-foot sidebar-foot-error inline-error" title={bootError}>
            <span className="status-dot" aria-hidden="true" />
            <span className="sidebar-foot-text">{bootError}</span>
          </div>
        ) : (
          <div className="sidebar-foot muted" title="Live: connected to the Corral server">
            <span className="status-dot" aria-hidden="true" />
            <span className="sidebar-foot-text">live</span>
          </div>
        )}
      </aside>
      {sidebarCollapsed ? null : (
        <ResizeHandle
          label="Resize sidebar"
          width={sidebarSize.width}
          limits={SIDEBAR_LIMITS}
          reserve={CONTENT_MIN_WIDTH}
          onChange={sidebarSize.setWidth}
          onReset={sidebarSize.reset}
        />
      )}
      <main className="content">
        {!online || stale ? (
          <div className="offline-banner">
            {online ? "Corral is unreachable" : "Offline"} — showing cached data. Actions
            will fail until the connection is back.
          </div>
        ) : null}
        <InboxPage active={tab === "inbox"} eventVersion={eventVersion} refresh={refresh} onSeen={markInboxSeen} />
        <ProgressCelebration eventVersion={eventVersion} onView={() => selectTab("progress")} />
        {tab === "progress" ? <ProgressPage eventVersion={eventVersion} /> : null}
        {tab === "daily" ? <DailyPage eventVersion={eventVersion} /> : null}
        {tab === "tasks" ? <TasksPage eventVersion={eventVersion} refresh={refresh} /> : null}
        {tab === "epics" ? <EpicsPage eventVersion={eventVersion} refresh={refresh} /> : null}
        {tab === "pulls" ? <PullsPage eventVersion={eventVersion} /> : null}
        {tab === "sessions" ? <SessionsPage eventVersion={eventVersion} /> : null}
        {tab === "usage" ? <UsagePage /> : null}
        {tab === "improve" ? <ImprovePage /> : null}
        {tab === "settings" ? <SettingsPage /> : null}
        {tab === "errors" ? <section><h1>Error center</h1><p className="muted">Current background synchronization errors. Errors clear after a successful refresh.</p>{errors.length === 0 ? <p>No current errors.</p> : errors.map((error) => <div className="inline-error" key={error.source}><strong>{error.source}</strong><p>{error.message}</p><small>{new Date(error.updated_ms).toLocaleString()}</small></div>)}</section> : null}
      </main>
      <SelectionToTask />
    </div>
    </MarkdownFileProvider>
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
          <BrandMark />
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
