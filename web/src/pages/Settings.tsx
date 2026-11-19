// Settings — read-only server config, Jira form, notification permission.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Config, Context, EffortFacts, Favorite, ModelFacts, ModelCatalog, Repo, Retention, Reviewer } from "../types";
import { RETENTIONS, retentionLabel } from "../model-indicators";
import { CONTEXTS } from "../favorite-context";
import { EMPTY_REVIEWER_DRAFT, REVIEWER_KINDS, draftToReviewer, isDelegate, reviewerBlocked, reviewerOptionLabel, reviewerSummary, reviewerToDraft } from "../reviewers";
import type { ReviewerDraft } from "../reviewers";
import { errText } from "../util";
import { Spinner } from "../ui";
import { ModelSettings } from "./Tasks";
import type { ModelOption } from "../task-page";
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
            { key: "favorites", label: "Favorites" },
            { key: "reviewers", label: "Reviewers" },
            { key: "models", label: "Models" },
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

            {section === "favorites" ? <FavoritesSection /> : null}
            {section === "reviewers" ? <ReviewersSection /> : null}
            {section === "models" ? <ModelsSection /> : null}
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
                  <span>Context</span>
                  <ContextSelect
                    value={repo.context ?? "professional"}
                    disabled={busy !== null}
                    onChange={(context) => void run("context", () => api.patchRepo(repo.id, { context }), "Context updated.")}
                  />
                </label>
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

const EMPTY_FAVORITE: Favorite = { name: "", harness: "", agent: "", model: "", reasoning: "", context: "professional", review: "" };

function ContextSelect({ value, onChange, disabled }: { value: Context; onChange: (context: Context) => void; disabled?: boolean }) {
  return <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Context)}>{CONTEXTS.map((c) => <option key={c} value={c}>{c}</option>)}</select>;
}

function FavoritesSection() {
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [catalog, setCatalog] = useState<{ harness: string; agents: { id: string; name: string }[]; models?: ModelOption[] }[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [draft, setDraft] = useState<Favorite>(EMPTY_FAVORITE);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  // The server is the source of truth: this section is remounted on every tab
  // switch, so seeding it from a snapshot taken when Settings loaded brought
  // old contexts back (and the next save wrote them over the saved ones).
  const loadFavorites = useCallback(async () => {
    const cfg = await api.getConfig();
    setFavorites(cfg.favorites ?? []);
    setReviewers(cfg.reviewers ?? []);
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.listHarnesses().then((r) => { if (!cancelled) { setCatalog(r.harnesses); setAgents(r.agents); } }).catch((e: unknown) => { if (!cancelled) setError(errText(e)); });
    loadFavorites().catch((e: unknown) => { if (!cancelled) setError(errText(e)); }).finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [loadFavorites]);
  const harness = draft.harness || catalog[0]?.harness || "";
  const matchingAgents = catalog.find((h) => h.harness === harness)?.agents ?? [];
  const update = (patch: Partial<Favorite>) => setDraft((d) => ({ ...d, ...patch }));
  const save = async (next: Favorite[]) => {
    setBusy(true); setError("");
    try {
      await api.putConfig({ favorites: next });
      setFavorites(next); setEditing(null); setDraft(EMPTY_FAVORITE);
      await loadFavorites().catch(() => undefined);
    }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return <section className="panel-form">
    <h2 className="panel-title">Task favorites</h2>
    <p className="muted">Save combinations for one-click selection when creating a task.</p>
    {!loaded ? <p className="muted"><Spinner /> Loading favorites…</p> : favorites.length === 0 ? <p className="muted">{error ? "Could not load favorites." : "No favorites yet — add one below."}</p> : <ul className="repo-list">{favorites.map((f, i) => <li className="repo-row" key={i}><div className="repo-info"><strong>{f.name}</strong><span className="muted">{[f.context, f.harness, agents.find((a) => a.id === f.agent)?.name || f.agent || "bare harness", f.model || "default model", f.reasoning || "default reasoning", f.review ? `review: ${f.review}` : "no review"].join(" · ")}</span></div><div className="repo-actions"><button className="btn" disabled={busy} onClick={() => { setDraft(f); setEditing(i); }}>Edit</button><button className="btn" disabled={busy} onClick={() => void save(favorites.filter((_, n) => n !== i))}>Remove</button></div></li>)}</ul>}
    <div className="field-row"><label className="field"><span>Name</span><input value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Code review" /></label>
    <label className="field"><span>Context</span><ContextSelect value={draft.context} onChange={(context) => update({ context })} /></label></div>
    <div className="field-row"><label className="field"><span>Reviewer</span><select value={draft.review} onChange={(e) => update({ review: e.target.value })}><option value="">— none —</option>{draft.review && !reviewers.some((r) => r.name === draft.review) ? <option value={draft.review}>{draft.review} (unavailable)</option> : null}{reviewers.map((r) => <option key={r.name} value={r.name} disabled={reviewerBlocked(r, harness, draft.agent)}>{reviewerOptionLabel(r, harness, draft.agent)}</option>)}</select></label>
    <label className="field"><span>Harness</span><select value={harness} onChange={(e) => update({ harness: e.target.value, agent: "", model: "", reasoning: "" })}>{catalog.length === 0 ? <option value="">No configured harnesses</option> : null}{draft.harness && !catalog.some((h) => h.harness === draft.harness) ? <option value={draft.harness}>{draft.harness} (unavailable)</option> : null}{catalog.map((h) => <option key={h.harness} value={h.harness}>{h.harness}</option>)}</select></label>
    <label className="field"><span>Agent</span><select value={draft.agent} onChange={(e) => update({ agent: e.target.value })}><option value="">— none (bare harness) —</option>{draft.agent && !matchingAgents.some((a) => a.id === draft.agent) ? <option value={draft.agent}>{draft.agent} (unavailable)</option> : null}{matchingAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div>
    <div className="field-row"><ModelSettings models={catalog.find((h) => h.harness === harness)?.models ?? []} model={draft.model} reasoning={draft.reasoning} setModel={(model) => update({ model })} setReasoning={(reasoning) => update({ reasoning })} fieldClass="field" /></div>
    {error ? <div className="inline-error">{error}</div> : null}
    <div className="form-foot"><button className="btn btn-primary" disabled={busy || !draft.name.trim() || !harness || (!!draft.agent && !matchingAgents.some((a) => a.id === draft.agent))} onClick={() => { const next = [...favorites]; const favorite = { ...draft, name: draft.name.trim(), harness }; if (editing === null) next.push(favorite); else next[editing] = favorite; void save(next); }}>{editing === null ? "Add favorite" : "Save favorite"}</button>{editing !== null ? <button className="btn" onClick={() => { setEditing(null); setDraft(EMPTY_FAVORITE); }}>Cancel</button> : null}</div>
  </section>;
}

function ReviewersSection() {
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<ReviewerDraft>(EMPTY_REVIEWER_DRAFT);
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const cfg = await api.getConfig();
    setReviewers(cfg.reviewers ?? []);
  }, []);
  useEffect(() => {
    let cancelled = false;
    load()
      .catch((e: unknown) => { if (!cancelled) setError(errText(e)); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [load]);

  const update = (patch: Partial<ReviewerDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const reviewer = draftToReviewer(draft);
  const save = async (next: Reviewer[]) => {
    setBusy(true); setError("");
    try {
      await api.putConfig({ reviewers: next });
      setReviewers(next); setEditing(null); setDraft(EMPTY_REVIEWER_DRAFT);
      await load().catch(() => undefined);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return <section className="panel-form">
    <h2 className="panel-title">Reviewers</h2>
    <p className="muted">Named reviews a code task runs on its diff before opening the PR. A command runs in the agent's shell: <span className="mono">{"{base_branch}"}</span> is replaced with the task's base branch at dispatch, and the resolved command is frozen on the task. A sub-agent review hands the diff to an <span className="mono">ocr delegate</span> sub-agent on the Claude or Codex harness, paid from that harness's quota.</p>
    {!loaded ? <p className="muted"><Spinner /> Loading reviewers…</p> : reviewers.length === 0 ? <p className="muted">{error ? "Could not load reviewers." : "No reviewers yet — add one below."}</p> : <ul className="repo-list">{reviewers.map((r, i) => <li className="repo-row" key={i}><div className="repo-info"><strong>{r.name}</strong><span className={isDelegate(r) ? "muted" : "mono muted"}>{reviewerSummary(r)}</span></div><div className="repo-actions"><button className="btn" disabled={busy} onClick={() => { setDraft(reviewerToDraft(r)); setEditing(i); }}>Edit</button><button className="btn" disabled={busy} onClick={() => void save(reviewers.filter((_, n) => n !== i))}>Remove</button></div></li>)}</ul>}
    <div className="field-row">
      <label className="field"><span>Name</span><input value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. cubic" /></label>
      <label className="field"><span>Runs</span><select value={draft.kind} onChange={(e) => update({ kind: e.target.value as ReviewerDraft["kind"] })}>{REVIEWER_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></label>
      {draft.kind === "command" ? <label className="field"><span>Command</span><input value={draft.command} onChange={(e) => update({ command: e.target.value })} placeholder="cubic review --base {base_branch} --json" /></label> : null}
    </div>
    {draft.kind === "command" ? null : <p className="muted form-hint">The task agent sends the review to a {draft.kind === "claude" ? "Claude" : "Codex"} sub-agent in the same worktree. It needs the Claude harness and no explicit agent.</p>}
    {error ? <div className="inline-error">{error}</div> : null}
    <div className="form-foot"><button className="btn btn-primary" disabled={busy || !reviewer} onClick={() => { if (!reviewer) return; const next = [...reviewers]; if (editing === null) next.push(reviewer); else next[editing] = reviewer; void save(next); }}>{editing === null ? "Add reviewer" : "Save reviewer"}</button>{editing !== null ? <button className="btn" onClick={() => { setEditing(null); setDraft(EMPTY_REVIEWER_DRAFT); }}>Cancel</button> : null}</div>
  </section>;
}

// ---- model facts catalog ----

// Facts are data the human edits: a new model release (or a correction) is a
// row here, never a code change. The shipped defaults are read-only; editing one
// stores an override under the same model key, removing it restores the default.

type EffortDraft = { effort: string; index: string; cost: string; min: string };
type BenchDraft = { name: string; score: string };
type FactsDraft = {
  id: string;
  retention: Retention;
  asOf: string;
  source: string;
  monthlyUsd: string;
  efforts: EffortDraft[];
  bench: BenchDraft[];
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const EMPTY_FACTS_DRAFT: FactsDraft = {
  id: "",
  retention: "none",
  asOf: todayIso(),
  source: "",
  monthlyUsd: "",
  efforts: [{ effort: "default", index: "", cost: "", min: "" }],
  bench: [],
};

const asText = (value: number | undefined) => (value === undefined ? "" : String(value));

function draftOf(id: string, facts: ModelFacts): FactsDraft {
  return {
    id,
    retention: facts.retention,
    asOf: facts.asOf,
    source: facts.source ?? "",
    monthlyUsd: asText(facts.quota?.monthlyUsd),
    efforts: Object.entries(facts.efforts ?? {}).map(([effort, row]) => ({ effort, index: asText(row.index), cost: asText(row.costPerTask), min: asText(row.minPerTask) })),
    bench: Object.entries(facts.bench ?? {}).map(([name, score]) => ({ name, score: String(score) })),
  };
}

/** Build the catalog entry the API will validate again; throws a readable message. */
function factsOf(draft: FactsDraft): { id: string; facts: ModelFacts } {
  const id = draft.id.trim();
  if (!id) throw new Error("Model id required.");
  const asOf = draft.asOf.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("As of must be YYYY-MM-DD.");
  const number = (raw: string, label: string): number | undefined => {
    if (!raw.trim()) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
    return value;
  };
  const efforts: NonNullable<ModelFacts["efforts"]> = {};
  for (const row of draft.efforts) {
    const effort = row.effort.trim() || "default";
    const facts: EffortFacts = {};
    const index = number(row.index, `Index for ${effort}`);
    const cost = number(row.cost, `Cost per task for ${effort}`);
    const min = number(row.min, `Minutes per task for ${effort}`);
    if (index !== undefined) facts.index = index;
    if (cost !== undefined) facts.costPerTask = cost;
    if (min !== undefined) facts.minPerTask = min;
    if (Object.keys(facts).length > 0) efforts[effort] = facts;
  }
  const bench: Record<string, number> = {};
  for (const row of draft.bench) {
    const name = row.name.trim();
    if (!name) continue;
    const score = number(row.score, `Score for ${name}`);
    if (score === undefined) throw new Error(`Score for ${name} is required.`);
    bench[name] = score;
  }
  const monthlyUsd = number(draft.monthlyUsd, "Monthly limit");
  return {
    id,
    facts: {
      retention: draft.retention,
      ...(monthlyUsd !== undefined ? { quota: { monthlyUsd } } : {}),
      ...(Object.keys(efforts).length > 0 ? { efforts } : {}),
      ...(Object.keys(bench).length > 0 ? { bench } : {}),
      asOf,
      ...(draft.source.trim() ? { source: draft.source.trim() } : {}),
    },
  };
}

function factsSummary(facts: ModelFacts): string {
  const first = facts.efforts?.default ?? Object.values(facts.efforts ?? {})[0];
  return [
    first?.index !== undefined ? `${first.index} index` : null,
    first?.costPerTask !== undefined ? `$${first.costPerTask.toFixed(2)}/task` : null,
    `retention ${retentionLabel(facts.retention)}`,
    facts.quota ? `$${facts.quota.monthlyUsd}/month` : null,
    `as of ${facts.asOf}`,
  ].filter(Boolean).join(" · ");
}

function ModelsSection() {
  const [catalog, setCatalog] = useState<ModelCatalog>({});
  const [mine, setMine] = useState<ModelCatalog>({});
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<FactsDraft>(EMPTY_FACTS_DRAFT);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The server is the source of truth (merged catalog + the user's overrides):
  // remounting the tab must not resurrect a stale snapshot.
  const load = useCallback(async () => {
    const [models, cfg] = await Promise.all([api.getModels(), api.getConfig()]);
    setCatalog(models.models);
    setMine(cfg.models ?? {});
  }, []);
  useEffect(() => {
    let cancelled = false;
    load()
      .catch((e: unknown) => { if (!cancelled) setError(errText(e)); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>, okMsg: string) => {
    if (busy) return;
    setBusy(label);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(okMsg);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const edit = (id: string) => {
    setError(null);
    setMsg(null);
    setDraft(draftOf(id, catalog[id]));
    setEditing(id);
  };

  const startAdd = () => {
    setError(null);
    setMsg(null);
    setDraft({ ...EMPTY_FACTS_DRAFT, efforts: [{ effort: "default", index: "", cost: "", min: "" }] });
    setEditing(null);
  };

  const save = () => {
    let parsed: { id: string; facts: ModelFacts };
    try { parsed = factsOf(draft); } catch (e) { setError(errText(e)); return; }
    void run("save", async () => {
      await api.putConfig({ models: { ...mine, [parsed.id]: parsed.facts } });
      setEditing(null);
      setDraft(EMPTY_FACTS_DRAFT);
    }, "Model facts saved — the indicators use them on the next page load.");
  };

  const remove = (id: string) => {
    void run("remove", async () => {
      const next = { ...mine };
      delete next[id];
      await api.putConfig({ models: next });
      if (editing === id) { setEditing(null); setDraft(EMPTY_FACTS_DRAFT); }
    }, "Override removed — the shipped facts apply again.");
  };

  const ids = Object.keys(catalog).sort();

  return <section className="panel-form models-panel">
    <h2 className="panel-title">Models</h2>
    <p className="muted">
      What Corral shows next to a model: quality (Artificial Analysis index, benchmark scores), cost per task,
      monthly plan limit, speed, data retention and when the numbers were collected. Corral chooses nothing from
      this — it only reports, and a warning never blocks a dispatch.
    </p>
    <p className="muted">
      Keys are the model ids your harnesses report (see <span className="mono">GET /api/harnesses</span>); use
      <span className="mono"> prefix*</span> for ids a harness suffixes with a date or variant. A model with no entry
      shows “no data”. Editing a shipped entry stores your version under the same key.
    </p>
    {!loaded ? <p className="muted"><Spinner /> Loading model facts…</p> : ids.length === 0 ? <p className="muted">No catalog entries yet — add one below.</p> : (
      <ul className="repo-list">
        {ids.map((id) => (
          <li className="repo-row" key={id}>
            <div className="repo-info">
              <span className="repo-name mono">{id}</span>
              <span className="muted">{factsSummary(catalog[id])}</span>
              {mine[id] ? <span className="badge badge-target">edited</span> : <span className="badge badge-mute">shipped</span>}
            </div>
            <div className="repo-actions">
              <button className="btn" disabled={busy !== null} onClick={() => edit(id)}>Edit</button>
              <button
                className="btn"
                disabled={busy !== null || !mine[id]}
                title={mine[id] ? "Remove your override; the shipped facts apply again" : "Shipped default — edit it to override it"}
                onClick={() => remove(id)}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    )}
    <h3 className="panel-subtitle">{editing ? `Edit ${editing}` : "Add a model"}</h3>
    <div className="field-row">
      <label className="field"><span>Model id</span><input value={draft.id} disabled={editing !== null} onChange={(e) => setDraft({ ...draft, id: e.target.value })} placeholder="opencode-go/kimi-k3.1-pro or claude-opus-5*" /></label>
      <label className="field"><span>Retention</span><select value={draft.retention} onChange={(e) => setDraft({ ...draft, retention: e.target.value as Retention })}>{RETENTIONS.map((retention) => <option key={retention} value={retention}>{retentionLabel(retention)}</option>)}</select></label>
      <label className="field"><span>As of</span><input value={draft.asOf} onChange={(e) => setDraft({ ...draft, asOf: e.target.value })} placeholder="2026-11-11" /></label>
    </div>
    <div className="field-row">
      <label className="field"><span>Monthly plan limit (USD, optional)</span><input type="number" step="any" value={draft.monthlyUsd} onChange={(e) => setDraft({ ...draft, monthlyUsd: e.target.value })} /></label>
      <label className="field"><span>Source (optional)</span><input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="Where the numbers come from" /></label>
    </div>
    <div className="field">
      <span>Efforts</span>
      {draft.efforts.map((row, index) => (
        <div className="field-row" key={index}>
          <label className="field"><span>Reasoning value</span><input value={row.effort} onChange={(e) => setDraft({ ...draft, efforts: draft.efforts.map((item, i) => i === index ? { ...item, effort: e.target.value } : item) })} placeholder="default, high, …" /></label>
          <label className="field"><span>Index</span><input type="number" step="any" value={row.index} onChange={(e) => setDraft({ ...draft, efforts: draft.efforts.map((item, i) => i === index ? { ...item, index: e.target.value } : item) })} /></label>
          <label className="field"><span>Cost/task USD</span><input type="number" step="any" value={row.cost} onChange={(e) => setDraft({ ...draft, efforts: draft.efforts.map((item, i) => i === index ? { ...item, cost: e.target.value } : item) })} /></label>
          <label className="field"><span>Minutes/task</span><input type="number" step="any" value={row.min} onChange={(e) => setDraft({ ...draft, efforts: draft.efforts.map((item, i) => i === index ? { ...item, min: e.target.value } : item) })} /></label>
          <button className="btn" disabled={draft.efforts.length === 1} onClick={() => setDraft({ ...draft, efforts: draft.efforts.filter((_, i) => i !== index) })}>Remove</button>
        </div>
      ))}
      <button className="btn" onClick={() => setDraft({ ...draft, efforts: [...draft.efforts, { effort: "", index: "", cost: "", min: "" }] })}>Add effort</button>
    </div>
    <div className="field">
      <span>Benchmark scores</span>
      {draft.bench.map((row, index) => (
        <div className="field-row" key={index}>
          <label className="field"><span>Benchmark</span><input value={row.name} onChange={(e) => setDraft({ ...draft, bench: draft.bench.map((item, i) => i === index ? { ...item, name: e.target.value } : item) })} placeholder="Terminal-Bench 4.0" /></label>
          <label className="field"><span>Score</span><input type="number" step="any" value={row.score} onChange={(e) => setDraft({ ...draft, bench: draft.bench.map((item, i) => i === index ? { ...item, score: e.target.value } : item) })} /></label>
          <button className="btn" onClick={() => setDraft({ ...draft, bench: draft.bench.filter((_, i) => i !== index) })}>Remove</button>
        </div>
      ))}
      <button className="btn" onClick={() => setDraft({ ...draft, bench: [...draft.bench, { name: "", score: "" }] })}>Add benchmark</button>
    </div>
    {error ? <div className="inline-error">{error}</div> : null}
    {msg ? <div className="inline-ok">{msg}</div> : null}
    <div className="form-foot">
      <button className="btn btn-primary" disabled={busy !== null || !draft.id.trim()} onClick={() => save()}>{busy === "save" ? <Spinner /> : null}{busy === "save" ? "Saving…" : editing ? "Save model" : "Add model"}</button>
      {editing !== null ? <button className="btn" disabled={busy !== null} onClick={startAdd}>New model</button> : null}
    </div>
  </section>;
}
