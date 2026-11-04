// Settings — read-only server config, Jira form, notification permission.

import { useEffect, useState } from "react";
import { api } from "../api";
import type { Config, Repo } from "../types";
import { errText } from "../util";
import { Spinner } from "../ui";
import { sendDesktopNotification } from "../notifications";

export function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("corral-theme") ?? "light");
  const [section, setSection] = useState<string>(() => {
    const q = window.location.hash.split("?")[1] ?? "";
    return new URLSearchParams(q).get("tab") ?? "general";
  });

  const setSectionTab = (s: string) => {
    setSection(s);
    window.history.replaceState(null, "", `#/settings${s !== "general" ? "?tab=" + s : ""}`);
  };

  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [jql, setJql] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [permission, setPermission] = useState<string>(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  );

  const [notificationResult, setNotificationResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        setJql(cfg.jiraJql ?? "");
        setError(null);
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
  }, []);

  const saveJira = async () => {
    if (saveBusy) return;
    setSaveBusy(true);
    setSaveMsg(null);
    setSaveError(null);
    try {
      // Only send fields that were filled in — the server merges.
      const jira: Record<string, string> = {};
      if (baseUrl.trim()) jira.baseUrl = baseUrl.trim();
      if (email.trim()) jira.email = email.trim();
      if (token.trim()) jira.token = token.trim();
      if (jql.trim()) jira.jql = jql.trim();
      if (Object.keys(jira).length === 0) {
        setSaveError("Nothing to save — fill in at least one field.");
        return;
      }
      await api.putConfig({ jira });
      setSaveMsg("Jira settings saved.");
      setBaseUrl("");
      setEmail("");
      setToken("");
      const cfg = await api.getConfig();
      setConfig(cfg);
    } catch (err) {
      setSaveError(errText(err));
    } finally {
      setSaveBusy(false);
    }
  };

  const enableNotifications = async () => {
    if (typeof Notification === "undefined") return;
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
    } catch {
      setPermission(Notification.permission);
    }
  };

  const applyTheme = (value: string) => {
    setTheme(value);
    // Persist "system" too: a missing preference means the light default.
    localStorage.setItem("corral-theme", value);
    document.documentElement.dataset.theme = value;
  };

  return (
    <div className="page settings-page">
      <div className="page-scroll">
        <div className="page-toolbar">
          <h1 className="page-title">Settings</h1>
        </div>

        {error ? <div className="inline-error">{error}</div> : null}
        <div className="chip-row settings-tabs">
          {[
            { key: "general", label: "General" },
            { key: "jira", label: "Jira" },
            { key: "repos", label: "Repos" },
          ].map((s) => (
            <button
              key={s.key}
              className={`chip ${section === s.key ? "chip-active" : ""}`}
              onClick={() => setSectionTab(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {loading ? (
          <div className="pane-note">
            <Spinner label="Loading…" />
          </div>
        ) : config ? (
          <div className="settings-grid">
            {section === "general" ? (
              <>
            <section className="panel-form">
              <h2 className="panel-title">Server</h2>
              <dl className="kv">
                <dt>Host</dt>
                <dd className="mono">{config.host}</dd>
                <dt>Port</dt>
                <dd className="mono">{config.port}</dd>
                <dt>Agents</dt>
                <dd className="mono">{config.agents.join(", ") || "—"}</dd>
                <dt>Assistant</dt>
                <dd className="mono">{config.assistant || "—"}</dd>
                <dt>Agent backend</dt>
                <dd className="mono">{config.backend || "—"}</dd>
                <dt>omnigent</dt>
                <dd className="mono">{config.omnigentUrl || "—"}</dd>
                <dt>API token</dt>
                <dd className="mono">{config.token}</dd>
                <dt>Jira</dt>
                <dd>{config.jiraConfigured ? "configured" : "not configured"}</dd>
              </dl>
            </section>
              </>
            ) : null}

            {section === "jira" ? (
            <section className="panel-form">
              <h2 className="panel-title">Jira</h2>
              <p className="muted">
                Used for search, import, comments and transitions. Leave a field blank to keep its current value.
              </p>
              <label className="field">
                <span>Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-team.atlassian.net"
                />
              </label>
              <label className="field">
                <span>Email</span>
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </label>
              <label className="field">
                <span>API token</span>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="off"
                />
              </label>
              <label className="field">
                <span>Default JQL</span>
                <input
                  value={jql}
                  onChange={(e) => setJql(e.target.value)}
                  placeholder='status = "In Progress"'
                />
              </label>
              {saveError ? <div className="inline-error">{saveError}</div> : null}
              {saveMsg ? <div className="inline-ok">{saveMsg}</div> : null}
              <div className="form-foot">
                <button className="btn btn-primary" onClick={() => void saveJira()} disabled={saveBusy}>
                  {saveBusy ? <Spinner /> : null}
                  {saveBusy ? "Saving…" : "Save Jira settings"}
                </button>
              </div>
            </section>
            ) : null}

            {section === "repos" ? <ReposSection /> : null}

            {section === "general" ? (
              <>
            <section className="panel-form">
              <h2 className="panel-title">Theme</h2>
              <p className="muted">Light is the default. Dark follows your OS only when set to "system".</p>
              <div className="chip-row">
                {[
                  { key: "light", label: "Light" },
                  { key: "dark", label: "Dark" },
                  { key: "system", label: "System" },
                ].map((t) => (
                  <button
                    key={t.key}
                    className={`chip ${theme === t.key ? "chip-active" : ""}`}
                    onClick={() => applyTheme(t.key)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="panel-form">
              <h2 className="panel-title">Desktop notifications</h2>
              <p className="muted">
                Get notified when an agent posts a question that needs you. Current permission:{" "}
                <strong>{permission}</strong>
              </p>
              {permission === "default" ? (
                <div className="form-foot">
                  <button className="btn btn-primary" onClick={() => void enableNotifications()}>
                    Enable notifications
                  </button>
                </div>
              ) : permission === "denied" ? (
                <p className="muted">Notifications are blocked in your browser settings.</p>
              ) : permission === "granted" ? (
                <div>
                  <p className="muted">Notifications are enabled.</p>
                  <div className="form-foot">
                    <button className="btn btn-primary" onClick={() => {
                      const failed = () => setNotificationResult("Could not send a notification. Check your browser and system notification settings.");
                      if (sendDesktopNotification("Corral test notification", "Desktop notifications are working.", failed)) {
                        setNotificationResult("Test notification requested. If you don't see it, check your browser and system notification settings, including Focus or Do Not Disturb.");
                      } else {
                        failed();
                      }
                    }}>
                      Test notification
                    </button>
                  </div>
                  {notificationResult && <p role="status">{notificationResult}</p>}
                </div>
              ) : (
                <p className="muted">This browser does not support desktop notifications.</p>
              )}
            </section>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---- repo registry ----

function ReposSection() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listRepos().then(setRepos).catch((err: unknown) => setError(errText(err)));

  useEffect(() => {
    void load();
  }, []);

  const run = async (label: string, fn: () => Promise<unknown>, okMsg?: string) => {
    if (busy) return;
    setBusy(label);
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (okMsg) setMsg(okMsg);
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel-form">
      <h2 className="panel-title">Repos</h2>
      <p className="muted">
        The git repos tasks can dispatch into. Jira issues whose key starts with the prefix (e.g.{" "}
        <span className="mono">QOV</span> for <span className="mono">QOV-123</span>) import straight into that repo.
      </p>
      {repos.length === 0 ? (
        <p className="muted">No repos yet — add one below or scan your workspace.</p>
      ) : (
        <ul className="repo-list">
          {repos.map((repo) => (
            <li key={repo.id} className="repo-row">
              <div className="repo-info">
                <span className="repo-name">{repo.name}</span>
                <span className="mono muted">{repo.path}</span>
                {repo.source === "scan" ? <span className="badge badge-mute">scanned</span> : null}
              </div>
              <div className="repo-actions">
                <label className="field-inline">
                  <span>Jira prefix</span>
                  <input
                    className="prefix-input"
                    defaultValue={repo.jira_prefix ?? ""}
                    placeholder="e.g. QOV"
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (value !== (repo.jira_prefix ?? "")) {
                        void run("prefix", () => api.patchRepo(repo.id, { jira_prefix: value || null }), "Prefix updated.");
                      }
                    }}
                  />
                </label>
                <button
                  className="btn"
                  onClick={() => void run(`del-${repo.id}`, () => api.deleteRepo(repo.id), "Repo removed.")}
                  disabled={busy !== null}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="field-row">
        <label className="field">
          <span>Path</span>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/git/repo" />
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="api" />
        </label>
        <label className="field">
          <span>Jira prefix (optional)</span>
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="QOV" />
        </label>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {msg ? <div className="inline-ok">{msg}</div> : null}
      <div className="form-foot">
        <button
          className="btn btn-primary"
          onClick={() =>
            void run(
              "add",
              () =>
                api
                  .addRepo({ path: path.trim(), name: name.trim() || undefined, jira_prefix: prefix.trim() || undefined })
                  .then(() => {
                    setPath("");
                    setName("");
                    setPrefix("");
                  }),
              "Repo added.",
            )
          }
          disabled={busy !== null || !path.trim()}
        >
          {busy === "add" ? <Spinner /> : null}
          Add repo
        </button>
        <button
          className="btn"
          onClick={() =>
            void run("scan", async () => {
              const res = await api.scanRepos();
              setMsg(`Scan complete — ${res.added.length} new, ${res.total} total (${res.roots.join(", ")}).`);
            })
          }
          disabled={busy !== null}
        >
          {busy === "scan" ? <Spinner /> : null}
          Scan workspace
        </button>
      </div>
    </section>
  );
}
