// Passive local Antigravity (`agy`) activity probe.
//
// Omnigent 0.23.0's `antigravity_native` RPC reader can emit a premature
// `idle` status mid-turn when a streamed `PLANNER_RESPONSE` step carries
// progress text alongside tool calls (StreamAgentStateUpdates strips
// `toolCalls`). When Omnigent reports a live Antigravity session as `idle`,
// Corral cross-checks local running `agy` Connect-RPC language servers via
// `GetAllCascadeTrajectories` and keeps the session `working` while its cascade
// is still `CASCADE_RUN_STATUS_RUNNING`. Strictly passive: never spawns `agy`.

import { withDeadline } from "./deadline.ts";
import { resolveExecutable, runAsync } from "./exec.ts";
import { listListeningPorts, postConnectJson } from "./google-quota.ts";

const SERVICE_PREFIX = "/exa.language_server_pb.LanguageServerService";
const TRAJECTORIES_PATH = `${SERVICE_PREFIX}/GetAllCascadeTrajectories`;
const CASCADE_STATUS_RUNNING = "CASCADE_RUN_STATUS_RUNNING";

const DEFAULT_CACHE_TTL_MS = 2_000;
const DEFAULT_PROBE_BUDGET_MS = 1_500;
const DEFAULT_RPC_TIMEOUT_MS = 1_000;
const PS_DIRS = ["/bin", "/usr/bin"];

type Run = (cmd: string, args: string[], opts?: { timeout?: number; allowFailure?: boolean }) => Promise<string>;
type RpcPost = (
  port: number,
  path: string,
  csrfToken: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<Record<string, unknown> | null>;

export interface AntigravitySessionProcess {
  pid: number;
  ppid: number;
  csrfToken: string;
  extensionPort: number | null;
  conversationId: string | null;
  omnigentSessionId: string | null;
}

export interface AntigravityActivitySnapshot {
  runningCascades: ReadonlySet<string>;
  knownCascades: ReadonlySet<string>;
  runningSessions: ReadonlySet<string>;
}

export const EMPTY_ANTIGRAVITY_ACTIVITY: AntigravityActivitySnapshot = {
  runningCascades: new Set(),
  knownCascades: new Set(),
  runningSessions: new Set(),
};

/** Parse `ps -ax -o pid=,ppid=,command=` output for running `agy` CLI
 *  processes carrying `--csrf_token` and map each to its parent `tmux`
 *  session's `@omnigent-conversation-link` id when available. */
export function parseAntigravitySessionProcesses(psOutput: string): AntigravitySessionProcess[] {
  const rows: { pid: number; ppid: number; command: string; base: string }[] = [];
  const tmuxSessions = new Map<number, string>();

  for (const line of psOutput.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[3];
    const argv0 = command.trim().split(/\s+/)[0] ?? "";
    const base = argv0.split("/").pop() ?? "";
    rows.push({ pid, ppid, command, base });
    if (base === "tmux") {
      const linkMatch = command.match(/@omnigent-conversation-link\s+['"]?\S+\/c\/([A-Za-z0-9_-]+)/);
      if (linkMatch?.[1]) tmuxSessions.set(pid, linkMatch[1]);
    }
  }

  const procs: AntigravitySessionProcess[] = [];
  for (const row of rows) {
    if (row.base !== "agy") continue;
    const tokenMatch = row.command.match(/--csrf_token(?:=|\s+)([^\s]+)/);
    if (!tokenMatch?.[1]) continue;
    const extMatch = row.command.match(/--extension_server_port(?:=|\s+)(\d+)/);
    const extensionPort = extMatch ? Number(extMatch[1]) : null;
    const convMatch = row.command.match(/--conversation(?:=|\s+)([^\s]+)/);
    procs.push({
      pid: row.pid,
      ppid: row.ppid,
      csrfToken: tokenMatch[1],
      extensionPort: extensionPort && extensionPort > 0 && extensionPort <= 65535 ? extensionPort : null,
      conversationId: convMatch?.[1] ?? null,
      omnigentSessionId: tmuxSessions.get(row.ppid) ?? null,
    });
  }
  return procs;
}

/** Parse a `GetAllCascadeTrajectories` Connect-RPC response into sets of
 *  running and known cascade ids. Running child/subagent trajectories mark
 *  their parent and root cascades running as well. */
export function parseCascadeTrajectories(
  payload: Record<string, unknown> | null | undefined,
): { running: Set<string>; known: Set<string> } | null {
  const summaries = payload?.trajectorySummaries;
  if (!summaries || typeof summaries !== "object" || Array.isArray(summaries)) return null;

  const running = new Set<string>();
  const known = new Set<string>();

  for (const [cascadeId, rawSummary] of Object.entries(summaries as Record<string, unknown>)) {
    if (!rawSummary || typeof rawSummary !== "object" || Array.isArray(rawSummary)) continue;
    known.add(cascadeId);
    const summary = rawSummary as Record<string, unknown>;
    if (summary.status !== CASCADE_STATUS_RUNNING) continue;
    running.add(cascadeId);
    const meta = summary.trajectoryMetadata;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    const record = meta as Record<string, unknown>;
    for (const key of ["rootConversationId", "parentConversationId"] as const) {
      const parentId = record[key];
      if (typeof parentId === "string" && parentId.length > 0) {
        running.add(parentId);
        known.add(parentId);
      }
    }
  }

  return { running, known };
}

/** Decide whether a session reported as `idle` by Omnigent is actually still
 *  running according to local `agy` Connect-RPC state. An explicit idle entry
 *  for `externalSessionId` overrides the coarse `tmux` session fallback. */
export function isAntigravityCascadeRunning(
  snapshot: AntigravityActivitySnapshot,
  opts: { address: string; externalSessionId: string | null },
): boolean {
  if (opts.externalSessionId && snapshot.runningCascades.has(opts.externalSessionId)) return true;
  if (opts.externalSessionId && snapshot.knownCascades.has(opts.externalSessionId)) return false;
  if (snapshot.runningSessions.has(opts.address)) return true;
  return false;
}

/** Passively inspect running local `agy` processes and query their loopback
 *  Connect-RPC servers for active cascades. Never spawns `agy` and fails open
 *  to an empty/partial snapshot on any process or RPC error. */
export async function probeAntigravityActivity(
  options: {
    run?: Run;
    listPorts?: (pid: number) => Promise<number[]>;
    post?: RpcPost;
    rpcTimeoutMs?: number;
  } = {},
): Promise<AntigravityActivitySnapshot> {
  const run = options.run ?? runAsync;
  const listPorts = options.listPorts ?? listListeningPorts;
  const post: RpcPost = options.post ?? postConnectJson;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  let procs: AntigravitySessionProcess[] = [];
  try {
    const ps = resolveExecutable("ps", PS_DIRS) ?? "ps";
    const out = await run(ps, ["-ax", "-o", "pid=,ppid=,command="], {
      timeout: DEFAULT_PROBE_BUDGET_MS,
      allowFailure: true,
    });
    procs = parseAntigravitySessionProcesses(out);
  } catch {
    return EMPTY_ANTIGRAVITY_ACTIVITY;
  }
  if (procs.length === 0) return EMPTY_ANTIGRAVITY_ACTIVITY;

  const runningCascades = new Set<string>();
  const knownCascades = new Set<string>();
  const runningSessions = new Set<string>();

  await Promise.all(
    procs.map(async (proc) => {
      try {
        const ports = [...(await listPorts(proc.pid))];
        if (proc.extensionPort && !ports.includes(proc.extensionPort)) {
          ports.push(proc.extensionPort);
        }
        for (const port of ports) {
          const res = await post(port, TRAJECTORIES_PATH, proc.csrfToken, {}, rpcTimeoutMs);
          const parsed = parseCascadeTrajectories(res);
          if (!parsed) continue;
          for (const id of parsed.known) knownCascades.add(id);
          for (const id of parsed.running) runningCascades.add(id);
          if (parsed.running.size > 0 && proc.omnigentSessionId) {
            runningSessions.add(proc.omnigentSessionId);
          }
          break;
        }
      } catch {
        // Fail open on individual process/RPC failures.
      }
    }),
  );

  return { runningCascades, knownCascades, runningSessions };
}

/** Short-TTL, single-flight, deadline-bounded cache around
 *  `probeAntigravityActivity()` so `list()`/`get()` bursts share one probe. */
export class AntigravityActivityCache {
  private probe: () => Promise<AntigravityActivitySnapshot>;
  private ttlMs: number;
  private budgetMs: number;
  private now: () => number;
  private cached: AntigravityActivitySnapshot | null = null;
  private cachedAt = 0;
  private inFlight: Promise<AntigravityActivitySnapshot> | null = null;

  constructor(
    probe: () => Promise<AntigravityActivitySnapshot> = () => probeAntigravityActivity(),
    opts: { ttlMs?: number; budgetMs?: number; now?: () => number } = {},
  ) {
    this.probe = probe;
    this.ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.budgetMs = opts.budgetMs ?? DEFAULT_PROBE_BUDGET_MS;
    this.now = opts.now ?? Date.now;
  }

  async snapshot(): Promise<AntigravityActivitySnapshot> {
    const t = this.now();
    if (this.cached && t - this.cachedAt < this.ttlMs) {
      return this.cached;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = withDeadline(
      this.probe().catch(() => EMPTY_ANTIGRAVITY_ACTIVITY),
      this.budgetMs,
      EMPTY_ANTIGRAVITY_ACTIVITY,
    )
      .then((result) => {
        this.cached = result;
        this.cachedAt = this.now();
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
