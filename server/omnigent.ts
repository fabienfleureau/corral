// Omnigent worker backend: Corral as a client of omnigent's REST API
// (/v1/sessions …). Worktrees are delegated to omnigent (git options on
// session create — its host daemon runs `git worktree add`). Events come from
// a tolerant polling loop rather than per-session streams: fewer moving parts,
// same information (status, blocked elicitations, tree).

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OmnigentConfig } from "./config.ts";
import { resolveExecutable, runAsync } from "./exec.ts";
import { LocalModelProbe } from "./model-probe.ts";
import type {
  WorkerAttachment,
  WorkerBackend,
  WorkerElicitation,
  WorkerEvent,
  WorkerEventSubscription,
  WorkerDelegate,
  WorkerSession,
  WorkerStart,
  WorkerModel,
  WorkerQuestion,
  WorkerRunOutcome,
  ModelAvailability,
} from "./worker.ts";

const POLL_MS = 4000;

/** agy's only pre-emptive permission control is an all-or-nothing bypass flag.
 *  Corral dispatches are unattended, so leaving agy's default request-review
 *  prompt on parks the task on a human approval card. Passed as session launch
 *  args, it also survives a relaunch of the session. */
const ANTIGRAVITY_LAUNCH_ARGS = ["--dangerously-skip-permissions"];

type OmnigentProject = { id: string; name: string; config: Record<string, unknown> };

/** Project membership Corral filed a session into, read before archiving. */
type FiledProject = { project: OmnigentProject | null; label: string | null };

/** Where a user install of a coding CLI usually lands. */
const CLI_DIRS = [
  join(homedir(), ".opencode/bin"),
  join(homedir(), ".local/bin"),
  join(homedir(), ".bun/bin"),
  join(homedir(), ".npm-global/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

/**
 * `opencode models` prints one model id per line (`provider/model`). Ids often
 * carry extra path segments (`nvidia/deepseek-ai/…`), so only whitespace and a
 * missing slash disqualify a line.
 */
function parseOpenCodeModels(stdout: string): WorkerModel[] {
  const ids = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("/") && !/\s/.test(line));
  return [...new Set(ids)].map((id) => ({ id, label: id, reasoning: [] }));
}

async function localOpenCodeModels(): Promise<WorkerModel[]> {
  const bin = resolveExecutable("opencode", CLI_DIRS);
  if (!bin) return [];
  try {
    return parseOpenCodeModels(await runAsync(bin, ["models"], { timeout: 5_000 }));
  } catch {
    return [];
  }
}

/**
 * `agy models` prints `id<TAB>Display name` rows. Antigravity puts the effort
 * in the id (`gemini-4-neon-high`), so the full id is what a dispatch needs.
 */
function parseAntigravityModels(stdout: string): WorkerModel[] {
  const models = new Map<string, WorkerModel>();
  for (const line of stdout.split(/\r?\n/)) {
    const [id, label] = line.trim().split(/\t+/);
    if (!id || !/^\S+$/.test(id)) continue;
    models.set(id, { id, label: label?.trim() || id, reasoning: [] });
  }
  return [...models.values()];
}

async function localAntigravityModels(): Promise<WorkerModel[]> {
  const bin = resolveExecutable("agy", CLI_DIRS);
  if (!bin) return [];
  try {
    return parseAntigravityModels(await runAsync(bin, ["models"], { timeout: 5_000 }));
  } catch {
    return [];
  }
}

/** "claude-native-ui" | "claude-sdk" | "claude-native" -> "claude"; "acp:junie" -> "junie" */
export function harnessOf(agentHarness: string): string {
  return agentHarness
    .replace(/-native-ui$/, "")
    .replace(/-native$/, "")
    .replace(/-sdk$/, "")
    .replace(/-ui$/, "")
    .replace(/^acp:/, "");
}

// ---- minimal tar.gz writer (for single-file agent bundles) ----

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum placeholder
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

type BundleFile = { name: string; content: string };

export function makeTarGz(files: BundleFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const body = Buffer.from(f.content, "utf8");
    parts.push(tarHeader(f.name, body.length));
    parts.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // end-of-archive
  return gzipSync(Buffer.concat(parts));
}

/**
 * The bundle of a bare harness agent that may hand work to sub-agents: the
 * parent runs the harness itself (like `corral-<harness>`) and adds `spawn`
 * plus the declared children, each in `agents/<name>/`. The registry keys
 * agents by name and never updates one, so a short hash of everything the
 * bundle carries goes into the name: a changed prompt registers a new agent
 * instead of silently running the old one.
 */
export function delegateBundle(
  short: string,
  harnessId: string,
  children: (WorkerDelegate & { harnessId: string })[],
): { name: string; files: BundleFile[] } {
  for (const c of children) {
    if (!/^[a-z][a-z0-9_]*$/.test(c.name)) throw new Error(`invalid delegate name: ${c.name}`);
  }
  const hash = createHash("sha256")
    .update(JSON.stringify([short, harnessId, children.map((c) => [c.name, c.harnessId, c.prompt])]))
    .digest("hex")
    .slice(0, 8);
  const name = `corral-${short}-delegate-${hash}`;
  const parent = [
    "spec_version: 1",
    `name: ${name}`,
    "description: Corral bare-harness agent that can delegate to sub-agents",
    "spawn: true",
    "executor:",
    "  type: omnigent",
    "  config:",
    `    harness: ${harnessId}`,
    "tools:",
    "  agents:",
    ...children.map((c) => `    - ${c.name}`),
    "",
  ].join("\n");
  const files: BundleFile[] = [{ name: "config.yaml", content: parent }];
  for (const c of children) {
    files.push({
      name: `agents/${c.name}/config.yaml`,
      content: [
        "spec_version: 1",
        `name: ${c.name}`,
        `description: Corral delegate on the ${c.harness} harness`,
        "executor:",
        "  type: omnigent",
        "  config:",
        `    harness: ${c.harnessId}`,
        // JSON is valid YAML: a quoted scalar needs no indentation rules for the prompt.
        `prompt: ${JSON.stringify(c.prompt)}`,
        "",
      ].join("\n"),
    });
  }
  return { name, files };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function epochMs(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return n < 1e12 ? n * 1000 : n; // omnigent reports seconds
}

/** omnigent live_status -> Corral status vocabulary. */
function normalizeStatus(live: string | null, blocked: boolean): string | null {
  if (blocked) return "blocked";
  switch (live) {
    case "launching":
    case "running":
      return "working";
    case "waiting":
      return "done"; // turn ended (background work may remain)
    case "idle":
      return "idle";
    case "failed":
      return "error";
    default:
      return null;
  }
}

export function normalizeElicitations(raw: unknown): WorkerElicitation[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkerElicitation[] = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const params = (e.params ?? e.request ?? e) as Record<string, unknown>;
    const id = str(e.elicitation_id) ?? str(e.id) ?? str(params.elicitation_id);
    if (!id) continue;
    const ask = params.ask_user_question as { questions?: unknown } | undefined;
    if (Array.isArray(ask?.questions) && ask.questions.length > 0) {
      const questions: WorkerQuestion[] = ask.questions.map((raw, index) => {
        const q = (raw ?? {}) as Record<string, unknown>;
        return {
          id: str(q.id) ?? String(index),
          prompt: str(q.question) ?? "(asked for input)",
          choices: Array.isArray(q.options) ? q.options.flatMap((option) => {
            const label = typeof option === "string" ? option : str(option?.label);
            return label ? [label] : [];
          }) : [],
          multiple: q.multiSelect === true,
        };
      });
      const single = questions.length === 1 && !questions[0].multiple ? questions[0] : null;
      out.push({ id, kind: "question", prompt: questions.map((q) => q.prompt).join("\n\n"),
        choices: single?.choices ?? [], field: single?.id ?? null, questions });
      continue;
    }
    const rawKind = [e.kind, e.type, params.type, params.kind, params.phase, params.policy_name].filter((v) => typeof v === "string").join(" ").toLowerCase();
    const kind = rawKind.includes("auth")
      ? "auth"
      : rawKind.includes("permission") || rawKind.includes("approval")
        ? "permission"
        : rawKind.includes("question") || rawKind.includes("input") || rawKind.includes("elicitation")
          ? "question"
          : "question";
    const prompt =
      str(params.message) ??
      str(params.prompt) ??
      str(params.text) ??
      str(e.message) ??
      str(e.prompt) ??
      "(asked for input)";
    const rawChoices = (params.options ?? params.items ?? params.choices ?? params.values ?? null) as unknown;
    const choices = Array.isArray(rawChoices)
      ? rawChoices.map((c) => (typeof c === "string" ? c : str((c as Record<string, unknown>)?.label) ?? str((c as Record<string, unknown>)?.value) ?? JSON.stringify(c))).slice(0, 8)
      : [];
    const schema = (params.requestedSchema ?? params.requested_schema ?? null) as { properties?: Record<string, unknown> } | null;
    const field = schema?.properties ? (Object.keys(schema.properties)[0] ?? null) : null;
    const persistPattern = params.phase === "agy_permission" ? str(params.always_allow_pattern) : null;
    out.push({ id, kind, prompt: prompt.slice(0, 4000), choices, field, ...(persistPattern ? { persistPattern } : {}) });
  }
  return out;
}

class OmnigentHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class OmnigentBackend implements WorkerBackend {
  name = "omnigent";
  private cfg: OmnigentConfig;
  private last = new Map<string, string>(); // address -> signature of status/elicitations
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false; // one tick at a time: an overlapping tick's stale view would emit false "finished"
  private subs = new Set<(e: WorkerEvent) => void>();
  private taskIds = new Map<string, string | null>();
  private localProbe = new LocalModelProbe();
  /** omnigent project name -> first-class project id (see `projectIdFor`). */
  private projectIds = new Map<string, string>();

  constructor(cfg: OmnigentConfig) {
    this.cfg = cfg;
  }

  /** Availability of a configured local model server (2 s timeout, 30 s cache).
   *  An unconfigured provider is unknown, not down. */
  async providerModels(provider: string): Promise<ModelAvailability> {
    const baseUrl = this.cfg.localProviders?.[provider];
    if (!baseUrl) return { status: "unknown", models: [] };
    return this.localProbe.availability(baseUrl);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
    // A FormData body sets its own multipart Content-Type, boundary included.
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
    const res = await fetch(new URL(path, this.cfg.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const hint =
        res.status === 404
          ? " (is the omnigent host online? `omnigent host status`)"
          : "";
      throw new OmnigentHttpError(res.status, `omnigent ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}${hint}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ---- normalization ----

  private async listAgents(): Promise<{ id: string; name: string; harness: string }[]> {
    const rows: Record<string, unknown>[] = [];
    for (const scope of ["", "&scope=user"]) {
      let after = "";
      const seen = new Set<string>();
      try {
        do {
          const res = await this.request<Record<string, unknown>>("GET", `/v1/agents?limit=200${scope}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
          rows.push(...((res.data ?? res.agents ?? []) as Record<string, unknown>[]));
          const next = res.has_more === true ? str(res.last_id) : undefined;
          if (!next || seen.has(next)) break;
          seen.add(next);
          after = next;
        } while (true);
      } catch {
        // Older servers may not support user agents.
      }
    }
    const ids = new Set<string>();
    return rows
        .map((r) => ({
          id: str(r.id) ?? "",
          name: str(r.name) ?? "",
          harness: str(r.harness) ?? "",
        }))
        .filter((a) => {
          if (!a.id || ids.has(a.id)) return false;
          ids.add(a.id);
          return true;
        });
  }

  async registryAgents(): Promise<{ id: string; name: string }[]> {
    return (await this.listAgents()).map(({ id, name }) => ({ id, name }));
  }

  /** Harness dimension of the registry: "claude", "codex", "opencode", … */
  async harnesses(): Promise<{ harness: string; agents: { id: string; name: string }[]; models?: WorkerModel[] }[]> {
    const agents = await this.listAgents();
    let readiness: Record<string, unknown> = {};
    let hostId = "";
    try {
      const res = await this.request<{ hosts?: { id?: string; host_id?: string; configured_harnesses?: Record<string, unknown> }[] }>("GET", "/v1/hosts");
      const hosts = res.hosts ?? [];
      const host = this.cfg.hostId ? hosts.find((h) => (h.host_id ?? h.id) === this.cfg.hostId) : hosts.length === 1 ? hosts[0] : undefined;
      readiness = host?.configured_harnesses ?? {};
      hostId = host?.host_id ?? host?.id ?? "";
    } catch {
      // Older or unreachable hosts may not report readiness.
    }
    const groups = new Map<string, { id: string; name: string }[]>();
    for (const a of agents) {
      const key = harnessOf(a.harness) || a.name;
      const list = groups.get(key) ?? [];
      list.push({ id: a.id, name: a.name });
      groups.set(key, list);
    }
    const available = [...groups.entries()]
      .filter(([short]) => {
        const ids = agents.map((a) => a.harness).filter((h) => harnessOf(h) === short);
        const id = ids.find((h) => h.endsWith("-native")) ?? ids.find((h) => h === short) ?? ids[0];
        const value = readiness[id];
        return value === undefined || value === null || value === true;
      })
      .sort(([a], [b]) => a.localeCompare(b));
    return Promise.all(available.map(async ([harness, groupAgents]) => {
      let models: WorkerModel[] = [];
      if (hostId) {
        try {
          const id = await this.harnessIdFor(harness);
          const result = await this.request<{ models?: Record<string, unknown>[] }>("GET", `/v1/hosts/${encodeURIComponent(hostId)}/harnesses/${encodeURIComponent(id)}/model-options`);
          models = (result.models ?? []).filter((m) => m.hidden !== true && str(m.id)).map((m) => ({
            id: str(m.id)!, label: str(m.displayName) ?? str(m.id)!,
            reasoning: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((r: Record<string, unknown>) => str(r.reasoningEffort)).filter((r): r is string => !!r) : harness === "claude" ? ["low", "medium", "high", "xhigh", "max"] : [],
          }));
        } catch { /* Fall back below when the catalog is unavailable. */ }
      }
      if (harness === "opencode" && !models.length) models = await localOpenCodeModels();
      if (harness === "antigravity" && !models.length) models = await localAntigravityModels();
      return { harness, agents: groupAgents, ...(models.length ? { models } : {}) };
    }));
  }

  /** Pick the registered agent for a harness: user agents before stock *-ui. */
  // (intentionally unused for dispatch: bare harness is the default and an
  // explicit agent is an explicit choice — resolution happens via start.agent)

  private normalize(raw: Record<string, unknown>): WorkerSession {
    const id = str(raw.id) ?? str(raw.session_id) ?? "";
    const labels = (raw.labels ?? {}) as Record<string, unknown>;
    const elicitations = normalizeElicitations(raw.pending_elicitations ?? []);
    const pendingCount = num(raw.pending_elicitations_count) ?? elicitations.length;
    const live = str(raw.live_status) ?? str(raw.status) ?? null;
    return {
      address: id,
      model: str(raw.llm_model),
      reasoning: str(raw.reasoning_effort),
      task_id: str(labels["corral.task"]) ?? this.taskIds.get(id) ?? null,
      name: str(raw.title) ?? str(raw.sub_agent_name),
      harness: str(labels["corral.harness"]) ?? null,
      status: normalizeStatus(live, pendingCount > 0 || elicitations.length > 0),
      blocked_kind: elicitations[0]?.kind ?? (pendingCount > 0 ? "question" : null),
      state: raw.archived === true || Boolean(raw.archived_at) ? "finished" : "live",
      turn: num(raw.turn) ?? num(raw.response_count) ?? 0,
      cwd: str(raw.workspace) ?? str(raw.cwd) ?? "",
      created_ms: epochMs(raw.created_ms) ?? epochMs(raw.created_at) ?? Date.now(),
      exit_code: live === "failed" ? 1 : null,
      parent: str(raw.parent_session_id),
    };
  }

  async start(start: WorkerStart): Promise<WorkerSession> {
    // File the session into the repository's omnigent project. `project_id` is
    // the membership omnigent's own project features read (project settings,
    // Canvas grouping, the project page, `GET /v1/sessions?project=`); the
    // legacy `omni_project` label below only keeps older servers grouping the
    // session in the sidebar.
    const projectName = start.project?.trim() ? start.project : null;
    const projectId = projectName ? await this.projectIdFor(projectName) : null;
    const meta: Record<string, unknown> = {
      // No title = omnigent generates one (untitled tasks).
      ...(start.name ? { title: start.name } : {}),
      labels: {
        "corral.task": start.taskId ?? "",
        "corral.harness": start.harness,
        ...(projectName ? { omni_project: projectName } : {}),
      },
      workspace: start.repoPath,
    };
    if (harnessOf(start.harness) === "antigravity") {
      // Set before create so the native terminal launches in yolo mode; the
      // worktree, not an interactive prompt, is the boundary for these tools.
      meta.terminal_launch_args = ANTIGRAVITY_LAUNCH_ARGS;
    }
    if (start.git) {
      // omnigent's host daemon creates the worktree (`<repo>-worktrees/<branch>`)
      meta.git = {
        branch_name: start.git.branch,
        ...(start.git.base ? { base_branch: start.git.base } : {}),
        ...(start.git.existingWorktree ? { existing_worktree: true } : {}),
      };
    } else if (projectId) {
      // A filed create fills omitted ``agent_id`` / ``workspace`` / ``git``
      // from the project's defaults. Corral decides the worktree itself, so an
      // explicit null keeps a project default from forcing one.
      meta.git = null;
    }
    if (this.cfg.hostId) meta.host_id = this.cfg.hostId;
    if (start.model) meta.model_override = start.model;
    if (start.reasoning) meta.reasoning_effort = start.reasoning;

    let agentId: string;
    if (start.delegates?.length) {
      // An explicit agent may not be able to call sub-agents, and agents stay an
      // explicit opt-in: the caller must not combine the two.
      if (start.agent) throw new Error("delegates cannot be combined with an explicit agent");
      agentId = await this.ensureDelegateAgent(start.harness, start.delegates);
    } else if (start.agent) {
      // Explicit agent choice: JSON create bound to that registered agent.
      const agents = await this.listAgents();
      const agent =
        agents.find((a) => a.id === start.agent) ??
        agents.find((a) => a.name === start.agent) ??
        null;
      if (!agent) {
        throw new Error(`omnigent agent "${start.agent}" not found in the registry`);
      }
      if (harnessOf(agent.harness) !== start.harness) {
        throw new Error(`Agent "${agent.name}" uses harness "${agent.harness}", incompatible with selected harness "${start.harness}"`);
      }
      agentId = agent.id;
    } else {
      // Bare harness: run Corral's own minimal agent for this harness (never a
      // named third-party agent), through the JSON create so worktrees work.
      agentId = await this.ensureHarnessAgent(start.harness);
    }
    const body: Record<string, unknown> = { ...meta, agent_id: agentId };
    let created: Record<string, unknown>;
    try {
      created = await this.request<Record<string, unknown>>("POST", "/v1/sessions", {
        ...body,
        ...(projectId ? { project_id: projectId } : {}),
      });
    } catch (err) {
      // A project deleted (or unshared) since we cached its id must not fail a
      // dispatch: forget it and retry once with the legacy label alone. The
      // next dispatch re-resolves the project. Any other failure (e.g. a
      // worktree collision) propagates untouched.
      const message = err instanceof Error ? err.message : String(err);
      const projectRejected =
        /\bproject\b/i.test(message) && /\b(not found|forbidden|not owned|unsupported|disabled)\b/i.test(message);
      if (!projectId || !projectName || !projectRejected) throw err;
      this.projectIds.delete(projectName);
      created = await this.request<Record<string, unknown>>("POST", "/v1/sessions", body);
    }
    const address = str(created.id) ?? str(created.session_id) ?? "";
    if (!address) throw new Error("omnigent create returned no session id");

    const session = (await this.get(address)) ?? this.normalize({ id: address, ...meta });
    if (start.taskId) this.taskIds.set(session.address, start.taskId);
    // The prompt must be delivered as an event to actually start the turn.
    try {
      // Files are session resources: upload each one, then reference it from
      // the message (the same two steps omnigent's own composer takes).
      const files: Record<string, unknown>[] = [];
      for (const file of start.attachments ?? []) files.push(await this.uploadAttachment(session.address, file));
      await this.sendContent(session.address, [...files, { type: "input_text", text: start.prompt }]);
    } catch (err) {
      throw new Error(`session created (${session.address}) but prompt delivery failed: ${err}`);
    }
    return session;
  }

  /** The caller's first-class projects, or null when the server has no
   *  projects API (older build: the legacy label is the only grouping). */
  private async listProjects(): Promise<OmnigentProject[] | null> {
    try {
      const res = await this.request<{ data?: Record<string, unknown>[] }>("GET", "/v1/projects");
      return (res.data ?? [])
        .map((p) => ({
          id: str(p.id) ?? "",
          name: str(p.name) ?? "",
          config: p.config && typeof p.config === "object" ? p.config as Record<string, unknown> : {},
        }))
        .filter((p) => p.id && p.name);
    } catch {
      return null;
    }
  }

  /** Find the repository project Corral filed this session into. Archived
   *  sessions stay members until they are unfiled, so read membership before
   *  archiving. Only Corral's own label/project pair is managed here: a session
   *  someone moved to another project keeps that membership. */
  private async filedProject(address: string): Promise<FiledProject | null> {
    let raw: Record<string, unknown>;
    try {
      raw = await this.request<Record<string, unknown>>("GET", `/v1/sessions/${address}`);
    } catch {
      return null;
    }
    const projectId = str(raw.project_id);
    const label = str(((raw.labels ?? {}) as Record<string, unknown>)["omni_project"]);
    if (!projectId && !label) return null;
    const project = projectId
      ? (await this.listProjects())?.find((p) => p.id === projectId) ?? null
      : null;
    if (project && (!label || project.name !== label)) return null;
    return { project, label };
  }

  /** Find-or-create the omnigent project named `name` (the task repository's
   *  display name), so a dispatched session is filed into a real project and
   *  not just labelled with one. Returns null when there is nothing to file
   *  into: an older server without the projects API, or one we could not
   *  reach/write — the dispatch then proceeds with the legacy label alone. */
  private async projectIdFor(name: string): Promise<string | null> {
    const cached = this.projectIds.get(name);
    if (cached) return cached;
    const known = await this.listProjects();
    if (known === null) return null;
    const existing = known.find((p) => p.name === name);
    if (existing) {
      this.projectIds.set(name, existing.id);
      return existing.id;
    }
    try {
      const created = await this.request<Record<string, unknown>>("POST", "/v1/projects", { name });
      const id = str(created.id);
      if (!id) return null;
      this.projectIds.set(name, id);
      return id;
    } catch {
      // A concurrent dispatch created it between our list and our create: the
      // server rejects the duplicate name, so re-read once and use that row.
      const raced = (await this.listProjects())?.find((p) => p.name === name);
      if (!raced) return null;
      this.projectIds.set(name, raced.id);
      return raced.id;
    }
  }

  /** Map a short harness name to the registry's engine id (prefer *-native). */
  private async harnessIdFor(short: string): Promise<string> {
    const harnesses = await this.listAgents();
    const ids = [...new Set(harnesses.map((a) => a.harness))].filter((h) => harnessOf(h) === short);
    const preferred =
      ids.find((h) => h.endsWith("-native")) ?? ids.find((h) => h === short) ?? ids[0];
    return preferred ?? short;
  }

  private harnessAgentIds = new Map<string, string>();

  /**
   * Find-or-create Corral's own bare-harness agent for a harness: a minimal
   * bundle (config.yaml with just executor.config.harness) registered as
   * `corral-<harness>`. Sessions then run THE HARNESS — never a named
   * third-party agent — while keeping the JSON create contract (worktrees,
   * model/reasoning pins).
   */
  private async ensureHarnessAgent(short: string): Promise<string> {
    return this.ensureBundleAgent(`corral-${short}`, async (name) => {
      const harnessId = await this.harnessIdFor(short);
      return [{
        name: "config.yaml",
        content: [
          "spec_version: 1",
          `name: ${name}`,
          "description: Corral bare-harness agent",
          "executor:",
          "  type: omnigent",
          "  config:",
          `    harness: ${harnessId}`,
          "",
        ].join("\n"),
      }];
    });
  }

  /** The bare harness agent that can also call `delegates` (spawn + children). */
  private async ensureDelegateAgent(short: string, delegates: WorkerDelegate[]): Promise<string> {
    const harnessId = await this.harnessIdFor(short);
    const children = await Promise.all(
      delegates.map(async (d) => ({ ...d, harnessId: await this.harnessIdFor(d.harness) })),
    );
    const bundle = delegateBundle(short, harnessId, children);
    return this.ensureBundleAgent(bundle.name, async () => bundle.files);
  }

  /** Find a user agent by name, or register it from a bundle (names are never updated). */
  private async ensureBundleAgent(name: string, files: (name: string) => Promise<BundleFile[]>): Promise<string> {
    const cached = this.harnessAgentIds.get(name);
    if (cached) return cached;
    const existing = (await this.listAgents()).find((a) => a.name === name);
    if (existing) {
      this.harnessAgentIds.set(name, existing.id);
      return existing.id;
    }
    const form = new FormData();
    form.append(
      "bundle",
      new Blob([makeTarGz(await files(name))], { type: "application/gzip" }),
      "agent.tar.gz",
    );
    const headers: Record<string, string> = {};
    if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
    const res = await fetch(new URL("/v1/agents", this.cfg.baseUrl), { method: "POST", headers, body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`omnigent POST /v1/agents (bundle) -> ${res.status}: ${text.slice(0, 300)}`);
    }
    const created = (await res.json()) as Record<string, unknown>;
    const id = str(created.id) ?? "";
    if (!id) throw new Error("omnigent agent registration returned no id");
    this.harnessAgentIds.set(name, id);
    return id;
  }

  async list(): Promise<WorkerSession[]> {
    const res = await this.request<Record<string, unknown>>("GET", "/v1/sessions?limit=200");
    const rows = (res.data ?? res.sessions ?? res) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => this.normalize(r as Record<string, unknown>));
  }

  async get(address: string, options?: { strict?: boolean }): Promise<WorkerSession | null> {
    try {
      const raw = await this.request<Record<string, unknown>>("GET", `/v1/sessions/${address}`);
      return this.normalize(raw);
    } catch (err) {
      if (options?.strict && !(err instanceof OmnigentHttpError && err.status === 404)) throw err;
      return null;
    }
  }

  async initialFailurePrompt(address: string): Promise<string | null> {
    const res = await this.request<Record<string, unknown>>("GET", `/v1/sessions/${address}/items?limit=200&order=asc`);
    const items = (res.data ?? res.items ?? []) as Record<string, unknown>[];
    if (items.length !== 2 || items[0].type !== "message" || items[0].role !== "user" ||
        items[1].type !== "error" || items[1].code !== "native_terminal_start_failed" ||
        (!str(items[0].response_id) || items[0].response_id !== items[1].response_id)) return null;
    const content = items[0].content;
    if (!Array.isArray(content)) return null;
    const text = content.map((part) => part?.type === "input_text" ? str(part.text) : null).filter(Boolean).join("\n");
    return text || null;
  }

  async lastRunOutcome(address: string): Promise<WorkerRunOutcome | null> {
    // Newest first: sessions outgrow one page, and only the tail says how the run ended.
    const res = await this.request<Record<string, unknown>>("GET", `/v1/sessions/${address}/items?limit=8&order=desc`);
    const items = (res.data ?? res.items ?? []) as Record<string, unknown>[];
    const last = items.find((item) => item.type !== "resource_event" && item.type !== "reasoning");
    if (!last) return null;
    if (last.type === "error") {
      const text = str(last.message) ?? str(last.code);
      return text ? { kind: "error", text } : null;
    }
    if (last.type === "message" && last.role === "assistant" && Array.isArray(last.content)) {
      const text = last.content.map((part) => str(part?.text)).filter(Boolean).join("\n").trim();
      return text ? { kind: "message", text } : null;
    }
    return null; // the human spoke last, or the run stopped between tool calls
  }

  async read(address: string, lines: number): Promise<string> {
    // Conversation history doubles as "recent output" — cleaner than raw
    // terminal capture and it survives across sessions.
    const text = await this.history(address);
    const split = text.split("\n");
    return split.slice(Math.max(0, split.length - lines)).join("\n");
  }

  async send(address: string, text: string): Promise<void> {
    await this.sendContent(address, [{ type: "input_text", text }]);
  }

  private async sendContent(address: string, content: Record<string, unknown>[]): Promise<void> {
    await this.request("POST", `/v1/sessions/${address}/events`, {
      type: "message",
      data: { role: "user", content },
    });
  }

  /** Store a file in the session and return the message part that points at it. */
  private async uploadAttachment(address: string, file: WorkerAttachment): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append("file", new Blob([file.data], { type: file.contentType }), file.filename);
    let stored: { id?: unknown; name?: unknown; metadata?: { filename?: unknown } };
    try {
      stored = await this.request("POST", `/v1/sessions/${encodeURIComponent(address)}/resources/files`, form);
    } catch (err) {
      throw new Error(`${file.filename}: ${err instanceof Error ? err.message : err}`);
    }
    const id = str(stored.id);
    if (!id) throw new Error(`omnigent stored ${file.filename} without returning a file id`);
    return {
      type: file.contentType.startsWith("image/") ? "input_image" : "input_file",
      file_id: id,
      filename: str(stored.metadata?.filename) ?? str(stored.name) ?? file.filename,
    };
  }

  async resolveElicitation(
    address: string,
    elicitationId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      "POST",
      `/v1/sessions/${address}/elicitations/${encodeURIComponent(elicitationId)}/resolve`,
      { action, ...(content ? { content } : {}), ...(meta ? { _meta: meta } : {}) },
    );
  }

  async archive(address: string): Promise<void> {
    const filed = await this.filedProject(address);
    const patch: Record<string, unknown> = { archived: true };
    if (filed?.project) patch.project_id = "";
    if (filed?.label) patch.labels = { omni_project: "" };
    let detached = true;
    try {
      await this.request("PATCH", `/v1/sessions/${address}`, patch);
    } catch (err) {
      if (!filed) throw err;
      // An older omnigent rejects the unfile fields: archiving alone still
      // works, but the session may still be filed, so skip project cleanup.
      detached = false;
      await this.request("PATCH", `/v1/sessions/${address}`, { archived: true });
    }
    if (!filed || !detached) return;
    try {
      await this.pruneProject(address, filed);
    } catch (err) {
      console.error("corral: omnigent project cleanup failed:", String(err));
    }
  }

  /** Sessions left in a project after Corral archived its own member are all
   *  archived. Detach them and remove the empty project, as omnigent's own
   *  "Delete project" flow does. Leave a project with live sessions, custom
   *  settings, a renamed folder, or too many members to inspect in one read. */
  private async pruneProject(address: string, filed: FiledProject): Promise<void> {
    const project = filed.project;
    if (!project || Object.keys(project.config).length > 0) return;
    const members = async (includeArchived: boolean): Promise<Record<string, unknown>[] | null> => {
      const params = new URLSearchParams({
        project: project.name,
        include_archived: String(includeArchived),
        visibility: "all",
        kind: "any",
        limit: "1000",
      });
      const res = await this.request<{ data?: Record<string, unknown>[]; has_more?: boolean }>(
        "GET", `/v1/sessions?${params}`,
      );
      if (res.has_more) return null;
      return (res.data ?? []).filter((s) => str(s.id) !== address);
    };
    const live = await members(false);
    if (live === null || live.length > 0) return; // unknown page size or live members
    const archived = await members(true);
    if (!archived?.length) {
      await this.request("DELETE", `/v1/projects/${encodeURIComponent(project.id)}`);
      this.projectIds.delete(project.name);
      return;
    }
    for (const session of archived) {
      const id = str(session.id);
      if (!id) continue;
      const labels = (session.labels ?? {}) as Record<string, unknown>;
      await this.request("PATCH", `/v1/sessions/${id}`, {
        project_id: "",
        ...(str(labels["omni_project"]) ? { labels: { omni_project: "" } } : {}),
      });
    }
    // A session filed while we detached the others must keep its project.
    if (!(await members(true))?.length) {
      await this.request("DELETE", `/v1/projects/${encodeURIComponent(project.id)}`);
      this.projectIds.delete(project.name);
    }
  }

  async kill(address: string): Promise<void> {
    try {
      await this.request("POST", `/v1/sessions/${address}/interrupt`, {});
    } catch {
      /* interrupt is best effort */
    }
    try {
      await this.archive(address);
    } catch {
      /* archive is best effort */
    }
  }

  async cleanup(address: string): Promise<void> {
    // omnigent removes the worktree with the session (delete_branch=true).
    // A 404 means the session is already gone (deleted earlier, or from a
    // previous backend) — treat cleanup as idempotent so retries stop.
    try {
      await this.request("DELETE", `/v1/sessions/${address}?delete_branch=true`);
    } catch (err) {
      if (err instanceof OmnigentHttpError && err.status === 404) return;
      try {
        await this.request("DELETE", `/v1/sessions/${address}`);
      } catch (fallbackErr) {
        if (fallbackErr instanceof OmnigentHttpError && fallbackErr.status === 404) return;
        throw fallbackErr;
      }
    }
  }

  async history(address: string): Promise<string> {
    try {
      const res = await this.request<Record<string, unknown>>(
        "GET",
        `/v1/sessions/${address}/items?limit=200&order=asc`,
      );
      const items = (res.data ?? res.items ?? []) as Record<string, unknown>[];
      const lines: string[] = [];
      for (const item of items) {
        const role = str(item.role) ?? str((item.data as Record<string, unknown>)?.role) ?? "";
        const content =
          (item.content ?? (item.data as Record<string, unknown>)?.content ?? item.text ?? item.body ?? null) as unknown;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          text = content
            .map((part) =>
              typeof part === "string"
                ? part
                : str((part as Record<string, unknown>)?.text) ?? str((part as Record<string, unknown>)?.content) ?? "",
            )
            .filter(Boolean)
            .join("\n");
        }
        if (text.trim()) lines.push(`${role ? role + ": " : ""}${text}`);
      }
      return lines.join("\n\n");
    } catch {
      return "";
    }
  }

  async tree(): Promise<{ address: string; children: string[] }[]> {
    const top = (await this.list()).filter((s) => !s.parent);
    const out: { address: string; children: string[] }[] = [];
    for (const s of top) {
      const children: string[] = [];
      const queue = [s.address];
      while (queue.length > 0 && children.length < 100) {
        const cur = queue.shift()!;
        try {
          const res = await this.request<Record<string, unknown>>(
            "GET",
            `/v1/sessions/${cur}/child_sessions?limit=50`,
          );
          const rows = (res.data ?? res.sessions ?? []) as Record<string, unknown>[];
          for (const r of rows) {
            const id = str(r.id) ?? str(r.session_id);
            if (id) {
              children.push(id);
              queue.push(id);
            }
          }
        } catch {
          /* tree is best effort */
        }
      }
      out.push({ address: s.address, children });
    }
    return out;
  }

  inspectUrl(address: string): string | null {
    // omnigent's own UI ("how the agent worked").
    return `${this.cfg.baseUrl.replace(/\/$/, "")}/c/${address}`;
  }

  // ---- events via polling ----

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.pollOnce();
    } finally {
      this.ticking = false;
    }
  }

  private async pollOnce(): Promise<void> {
    let sessions: WorkerSession[] = [];
    try {
      sessions = await this.list();
    } catch {
      return; // server unreachable — keep polling
    }
    const liveSessions = sessions.filter((s) => s.state !== "finished");
    for (const s of liveSessions) {
      // Enrich blocked sessions with their elicitation payloads.
      let elicitations: WorkerElicitation[] = [];
      if (s.status === "blocked") {
        try {
          const detail = await this.request<Record<string, unknown>>("GET", `/v1/sessions/${s.address}`);
          elicitations = normalizeElicitations(detail.pending_elicitations ?? []);
        } catch {
          /* detail is best effort */
        }
      }
      const sig = JSON.stringify([s.status, s.blocked_kind, elicitations.map((e) => e.id)]);
      const prev = this.last.get(s.address);
      if (prev === undefined) {
        this.last.set(s.address, sig);
        if (s.task_id) this.taskIds.set(s.address, s.task_id);
        this.emit({ type: "created", address: s.address, task_id: s.task_id, parent: s.parent, status: s.status, elicitations });
      } else if (prev !== sig || (s.task_id && ["idle", "done", "error"].includes(s.status ?? ""))) {
        this.last.set(s.address, sig);
        this.emit({
          type: "status",
          address: s.address,
          task_id: s.task_id ?? this.taskIds.get(s.address) ?? null,
          status: s.status,
          blocked_kind: s.blocked_kind,
          elicitations,
          parent: s.parent,
        });
      }
    }
    // Sessions we track that vanished (archived/deleted) count as finished.
    const seen = new Set(liveSessions.map((s) => s.address));
    for (const address of [...this.last.keys()]) {
      if (!seen.has(address)) {
        this.last.delete(address);
        this.emit({
          type: "finished",
          address,
          task_id: this.taskIds.get(address) ?? null,
          exit_code: null,
        });
      }
    }
  }

  private emit(e: WorkerEvent): void {
    for (const cb of this.subs) {
      try {
        cb(e);
      } catch {
        /* subscriber errors must not kill the loop */
      }
    }
  }

  onEvent(cb: (e: WorkerEvent) => void): WorkerEventSubscription {
    this.subs.add(cb);
    if (!this.timer) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), POLL_MS);
    }
    return {
      stop: () => {
        this.subs.delete(cb);
        if (this.subs.size === 0 && this.timer) {
          clearInterval(this.timer);
          this.timer = null;
        }
      },
    };
  }
}
