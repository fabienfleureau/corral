import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import type {
  EpicAgentE2e,
  EpicAgentE2eStatus,
  EpicAgentRunState,
  EpicAgentSettings,
  EpicAgentStepStatus,
  EpicAgentView,
} from "../../shared/epic-agent";
import { api } from "./api";
import { favoritesFor, repoContext } from "./favorite-context";
import { Markdown } from "./markdown";
import { OneTimeInstructionForm } from "./OneTimeInstructionForm";
import type { PaneLimits } from "./pane-size";
import { ResizeHandle } from "./ResizeHandle";
import type { Favorite, Repo } from "./types";
import { usePaneWidth } from "./use-pane-size";
import { errText } from "./util";

const SETTINGS_LIMITS: PaneLimits = { min: 320, max: 540 };
const SETTINGS_DEFAULT_WIDTH = 360;
const REPORT_MIN_WIDTH = 360;

const RUN_STATUS_LABEL: Record<EpicAgentRunState, string> = {
  starting: "Starting",
  running: "Implementing",
  blocked: "Needs attention",
  complete: "Last cycle complete",
  failed: "Last cycle failed",
};

const STEP_STATUS_LABEL: Record<EpicAgentStepStatus, string> = {
  done: "done",
  in_progress: "in progress",
  pending: "pending",
  blocked: "blocked",
};

const STEP_STATUS_BADGE: Record<EpicAgentStepStatus, string> = {
  done: "badge badge-ready",
  in_progress: "badge badge-mine",
  pending: "badge",
  blocked: "badge badge-wait",
};

const E2E_STATUS_LABEL: Record<EpicAgentE2eStatus, string> = {
  passed: "E2E passed",
  failed: "E2E failed",
  skipped: "E2E skipped",
  not_applicable: "E2E not applicable",
};

const E2E_STATUS_BADGE: Record<EpicAgentE2eStatus, string> = {
  passed: "badge badge-ready",
  failed: "badge badge-err",
  skipped: "badge badge-wait",
  not_applicable: "badge",
};

export function EpicAgentPanel({
  epicKey,
  view,
  repos,
  favorites,
  onUpdate,
}: {
  epicKey: string;
  view: EpicAgentView;
  repos: Repo[];
  favorites: Favorite[];
  onUpdate: (view: EpicAgentView) => void;
}) {
  const [settings, setSettings] = useState<EpicAgentSettings>(view.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const settingsPane = usePaneWidth("corral.epicAgentSettingsWidth", SETTINGS_DEFAULT_WIDTH, SETTINGS_LIMITS);

  // Sync draft settings when switching to another epic.
  useEffect(() => {
    setSettings(view.settings);
    setError("");
    setNotice("");
  }, [view.epicId]); // eslint-disable-line react-hooks/exhaustive-deps

  const { report, runState } = view;
  const running = runState === "starting" || runState === "running" || runState === "blocked";
  const dirty = (Object.keys(settings) as (keyof EpicAgentSettings)[]).some((key) => settings[key] !== view.settings[key]);
  const shownFavorites = favoritesFor(favorites, repoContext(repos, settings.repoPath));
  const favoriteAvailable = shownFavorites.some(({ name }) => name === settings.favorite);

  const change = (patch: Partial<EpicAgentSettings>) => {
    setSettings((previous) => ({ ...previous, ...patch }));
    setNotice("");
    setError("");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await api.configureEpicAgent(view.epicId, settings);
      onUpdate(updated);
      setSettings(updated.settings);
      setNotice("Settings saved.");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const run = async (instruction?: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      onUpdate(await api.runEpicAgent(view.epicId, instruction));
    } catch (err) {
      if (instruction) throw err;
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const canRun = !dirty && Boolean(settings.repoPath) && favoriteAvailable;
  const runDisabledReason = dirty
    ? "Save persistent settings before running."
    : !settings.repoPath || !favoriteAvailable
      ? "Configure a working directory and favorite in the settings pane first."
      : undefined;

  const stepsDone = report?.steps.filter((step) => step.status === "done").length ?? 0;
  const attentionCount = (report?.problems.length ?? 0) + (report?.specGaps.length ?? 0) + (report?.clarifications.length ?? 0);
  const paneStyle = { "--kpi-settings-width": `${settingsPane.width}px` } as CSSProperties;

  return (
    <section className="epic-agent-section" aria-labelledby="epic-agent-title">
      <div className="epic-agent-head">
        <h3 id="epic-agent-title">Autonomous implementation agent</h3>
        <span className="kpi-state" role="status">{runState ? RUN_STATUS_LABEL[runState] : "Awaiting first run"}</span>
      </div>

      <div className="kpi-layout epic-agent-layout">
        <div className="kpi-main epic-agent-main">
          <section className="panel-form kpi-overview">
            <div className="epic-agent-overview-head">
              <h4 className="panel-title">Current status</h4>
              {report && (
                <div className="epic-agent-pills">
                  {report.steps.length > 0 && (
                    <span className="badge">{stepsDone}/{report.steps.length} steps done</span>
                  )}
                  {report.e2e && (
                    <span className={E2E_STATUS_BADGE[report.e2e.status]}>{E2E_STATUS_LABEL[report.e2e.status]}</span>
                  )}
                  {attentionCount > 0 && (
                    <span className="badge badge-wait">{attentionCount} item{attentionCount > 1 ? "s" : ""} flagged</span>
                  )}
                </div>
              )}
            </div>
            <Markdown
              text={report?.summary ?? `Configure a working directory and favorite for ${epicKey}, then click **Run now** to let the agent autonomously discover steps, implement the epic, run E2E tests and flag any missing specs or clarifications.`}
              className="kpi-copy"
            />
            {view.reportMs !== null && (
              <p className="muted kpi-meta">
                Report updated <time dateTime={new Date(view.reportMs).toISOString()}>{new Date(view.reportMs).toLocaleString()}</time>
              </p>
            )}
          </section>

          <section className="panel-form">
            <h4 className="panel-title">Discovered steps</h4>
            {report?.steps.length ? (
              <ol className="epic-agent-steps">
                {report.steps.map((step, i) => (
                  <li key={i} className="epic-agent-step">
                    <div className="epic-agent-step-head">
                      <strong>{step.title}</strong>
                      <span className={STEP_STATUS_BADGE[step.status]}>{STEP_STATUS_LABEL[step.status]}</span>
                      {step.ticketKey && <span className="badge">{step.ticketKey}</span>}
                    </div>
                    {step.details && <Markdown text={step.details} className="kpi-copy muted" />}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted kpi-copy">
                {report ? "No implementation steps reported in the last cycle." : "Discovered implementation steps appear after the first run."}
              </p>
            )}
          </section>

          <E2eCard e2e={report?.e2e ?? null} hasReport={Boolean(report)} />

          <div className="epic-agent-findings">
            <AgentFindings title="Problems & blockers" entries={report?.problems} empty="No problems or blockers reported." />
            <AgentFindings title="Missing specs & info" entries={report?.specGaps} empty="No missing specifications or information." />
            <AgentFindings title="Clarifications needed" entries={report?.clarifications} empty="No clarifications requested." />
          </div>

          <OneTimeInstructionForm
            idPrefix="epic-agent-instruction"
            resetKey={view.epicId}
            headingLevel="h4"
            helpText="Sent once to the agent, then cleared. Use this to answer clarifications or steer the next cycle — the agent will fold durable answers into its memory."
            placeholder="Answer a clarification or give a one-time instruction for this run…"
            busy={busy}
            running={running}
            canRun={canRun}
            disabledReason={runDisabledReason}
            onSend={(instruction) => run(instruction)}
          />

          {report && (report.actionsTaken.length > 0 || report.nextSteps.length > 0) && (
            <div className="kpi-inputs">
              <AgentFindings title="Actions taken" entries={report.actionsTaken} empty="No code or workspace changes made in this cycle." />
              <AgentFindings title="Next steps" entries={report.nextSteps} empty="No remaining steps listed." />
            </div>
          )}

          {report?.memory && (
            <details className="panel-form">
              <summary className="panel-title">Agent memory</summary>
              <Markdown text={report.memory} className="kpi-copy" />
            </details>
          )}
        </div>

        <ResizeHandle
          label="Resize epic agent settings"
          side="end"
          width={settingsPane.width}
          limits={SETTINGS_LIMITS}
          reserve={REPORT_MIN_WIDTH}
          onChange={settingsPane.setWidth}
          onReset={settingsPane.reset}
        />

        <form className="panel-form kpi-agent" style={paneStyle} aria-labelledby="epic-agent-form-title" onSubmit={(event) => void save(event)}>
          <div className="kpi-agent-body">
            <div className="kpi-agent-heading">
              <h4 id="epic-agent-form-title" className="panel-title">Omnigent agent</h4>
              <span className="kpi-state" role="status">{runState ? RUN_STATUS_LABEL[runState] : "Idle"}</span>
            </div>
            {view.sessionUrl && (
              <a href={view.sessionUrl} target="_blank" rel="noreferrer">View session in Omnigent ↗</a>
            )}
            {view.error && <div className="inline-error" role="alert">{view.error}</div>}
            {runState === "blocked" && (
              <p className="muted kpi-copy">Open the Omnigent session to see what needs attention.</p>
            )}

            <div className="field">
              <label htmlFor="epic-agent-workdir">Working directory</label>
              <input
                id="epic-agent-workdir"
                name="repoPath"
                list="epic-agent-workdirs"
                value={settings.repoPath}
                disabled={busy}
                maxLength={2000}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="/path/to/workspace"
                aria-describedby="epic-agent-workdir-help"
                onChange={(event) => {
                  const repoPath = event.target.value;
                  const allowed = favoritesFor(favorites, repoContext(repos, repoPath.trim()));
                  change({
                    repoPath,
                    favorite: settings.favorite && allowed.some((f) => f.name === settings.favorite) ? settings.favorite : "",
                  });
                }}
              />
              <datalist id="epic-agent-workdirs">
                {repos.map(({ id, name, path }) => <option key={id} value={path}>{name}</option>)}
              </datalist>
              <small id="epic-agent-workdir-help" className="muted kpi-meta">
                Absolute folder or workspace path. The agent discovers repos, implements steps and keeps durable memory in <code>.corral/</code>.
              </small>
            </div>

            <div className="field">
              <label htmlFor="epic-agent-favorite">Favorite</label>
              <select
                id="epic-agent-favorite"
                name="favorite"
                value={favoriteAvailable ? settings.favorite : settings.favorite ? "unavailable" : ""}
                disabled={busy}
                aria-describedby="epic-agent-favorite-help"
                onChange={(event) => change({ favorite: event.target.value })}
              >
                <option value="">Choose a favorite</option>
                {settings.favorite && !favoriteAvailable && (
                  <option value="unavailable">{settings.favorite} (unavailable)</option>
                )}
                {shownFavorites.map(({ name, harness, agent }) => (
                  <option key={name} value={name}>{name} — {harness}{agent ? ` · ${agent}` : ""}</option>
                ))}
              </select>
              <small id="epic-agent-favorite-help" className="muted kpi-meta">
                Supplies the harness, agent, model and reasoning. Filtered by the working directory context.
              </small>
            </div>

            <div className="field">
              <label htmlFor="epic-agent-cadence">Run automatically</label>
              <select
                id="epic-agent-cadence"
                name="intervalHours"
                value={settings.intervalHours}
                disabled={busy}
                onChange={(event) => change({ intervalHours: Number(event.target.value) as EpicAgentSettings["intervalHours"] })}
              >
                <option value={0}>Off</option>
                <option value={1}>Hourly</option>
                <option value={24}>Daily</option>
              </select>
              <small className="muted kpi-meta">Automatic cycles require Corral and the Omnigent runner to stay online.</small>
              {view.nextRunMs !== null && (
                <small className="muted kpi-meta">
                  Next cycle {view.nextRunMs <= Date.now() ? "due now" : new Date(view.nextRunMs).toLocaleString()}
                </small>
              )}
            </div>

            <div className="field">
              <label htmlFor="epic-agent-context">Persistent context</label>
              <textarea
                id="epic-agent-context"
                name="context"
                rows={4}
                maxLength={6000}
                value={settings.context}
                disabled={busy}
                aria-describedby="epic-agent-context-help"
                onChange={(event) => change({ context: event.target.value })}
              />
              <small id="epic-agent-context-help" className="muted kpi-meta">
                Saved across every cycle. Use for standing constraints, conventions, or durable epic context — not one-off answers.
              </small>
            </div>
          </div>

          {error && <div className="inline-error" role="alert">{error}</div>}
          {notice && <p className="muted kpi-meta" role="status">{notice}</p>}
          <div className="form-foot">
            <button type="submit" className="btn btn-primary" disabled={busy}>Save settings</button>
            <button
              type="button"
              className="btn"
              disabled={busy || running || dirty || !settings.repoPath || !favoriteAvailable}
              onClick={() => void run()}
            >
              Run now
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function E2eCard({ e2e, hasReport }: { e2e: EpicAgentE2e | null; hasReport: boolean }) {
  return (
    <section className="panel-form">
      <div className="epic-agent-overview-head">
        <h4 className="panel-title">E2E verification</h4>
        {e2e && <span className={E2E_STATUS_BADGE[e2e.status]}>{E2E_STATUS_LABEL[e2e.status]}</span>}
      </div>
      {e2e ? (
        <>
          <Markdown text={e2e.summary} className="kpi-copy" />
          {e2e.commands.length > 0 && (
            <ul className="epic-agent-commands" aria-label="E2E commands run">
              {e2e.commands.map((command, i) => <li key={i}><code>{command}</code></li>)}
            </ul>
          )}
          {e2e.gaps.length > 0 && (
            <div className="epic-agent-e2e-gaps">
              <p className="muted kpi-meta">E2E gaps</p>
              <ul className="kpi-list">
                {e2e.gaps.map((gap, i) => <li key={i}><Markdown text={gap} /></li>)}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="muted kpi-copy">
          {hasReport ? "No E2E verification reported in the last cycle." : "E2E test results appear here once the agent runs."}
        </p>
      )}
    </section>
  );
}

function AgentFindings({ title, entries, empty }: { title: string; entries?: string[]; empty: string }) {
  return (
    <section className="panel-form">
      <h4 className="panel-title">{title}</h4>
      {entries?.length ? (
        <ul className="kpi-list">
          {entries.map((entry, i) => <li key={i}><Markdown text={entry} /></li>)}
        </ul>
      ) : (
        <p className="muted kpi-copy">{entries ? empty : "Awaiting the first run."}</p>
      )}
    </section>
  );
}
