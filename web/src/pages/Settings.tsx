// Settings — read-only server config, Jira form, notification permission.

import { useEffect, useState } from "react";
import { api } from "../api";
import type { Config } from "../types";
import { errText } from "../util";
import { Spinner } from "../ui";

export function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="page settings-page">
      <div className="page-scroll">
        <div className="page-toolbar">
          <h1 className="page-title">Settings</h1>
        </div>

        {error ? <div className="inline-error">{error}</div> : null}
        {loading ? (
          <div className="pane-note">
            <Spinner label="Loading…" />
          </div>
        ) : config ? (
          <div className="settings-grid">
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
                <dt>herdr socket</dt>
                <dd className="mono">{config.herdrSocket || "—"}</dd>
                <dt>Worktrees dir</dt>
                <dd className="mono">{config.worktreesDir || "—"}</dd>
                <dt>API token</dt>
                <dd className="mono">{config.token}</dd>
                <dt>Jira</dt>
                <dd>{config.jiraConfigured ? "configured" : "not configured"}</dd>
              </dl>
            </section>

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
                <p className="muted">Notifications are enabled.</p>
              ) : (
                <p className="muted">This browser does not support desktop notifications.</p>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
