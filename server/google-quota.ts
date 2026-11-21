// Google quota comes directly from Antigravity's local language server
// (Connect RPC over loopback). Both Antigravity IDE's `language_server_*`
// process and the `agy` CLI (which embeds the language server) expose it.
// If neither is running, Corral temporarily starts `agy` (with auto-update
// disabled) in a PTY, queries quota, and tears it down. Corral never reads
// or stores Google credentials.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveExecutable, runAsync } from "./exec.ts";
import { QuotaCache, type AgentQuota, type QuotaWindow } from "./usage.ts";

const SERVICE_PREFIX = "/exa.language_server_pb.LanguageServerService";
const QUOTA_SUMMARY_PATH = `${SERVICE_PREFIX}/RetrieveUserQuotaSummary`;
const USER_STATUS_PATH = `${SERVICE_PREFIX}/GetUserStatus`;

// Minimal PTY runner: `agy` needs a TTY to boot its local server, and macOS
// `/usr/bin/script` fails with ENOTTY when spawned from a daemon without one.
const PTY_HELPER = [
  "import os, pty, select, sys",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  "  os.execvp(sys.argv[1], sys.argv[1:])",
  "while True:",
  "  r, _, _ = select.select([fd], [], [], 0.5)",
  "  if r:",
  "    try:",
  "      if not os.read(fd, 4096): break",
  "    except OSError:",
  "      break",
].join("\n");

type Json = Record<string, any>;
type Run = (cmd: string, args: string[], opts?: { timeout?: number; allowFailure?: boolean }) => Promise<string>;
type RpcPost = (port: number, path: string, csrfToken: string, body: Json) => Promise<Json | null>;

export interface LanguageServerProcess {
  pid: number;
  ppid: number;
  csrfToken: string;
  extensionPort: number | null;
}

export interface SpawnedAgy {
  pid?: number;
  csrfToken: string;
  stop: () => void | Promise<void>;
}

export function emptyGoogleQuota(note: string): AgentQuota {
  return { agent: "google", source: "Antigravity", as_of_ms: null, stale: true, plan: null, windows: [], note };
}

function ms(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function usedPercentFrom(raw: Json | null | undefined): number | null {
  if (!raw) return null;
  if (typeof raw.remainingFraction === "number" && Number.isFinite(raw.remainingFraction)) {
    const remaining = Math.max(0, Math.min(1, raw.remainingFraction));
    return Math.round((1 - remaining) * 1000) / 10;
  }
  if (typeof raw.usedPercent === "number" && Number.isFinite(raw.usedPercent)) {
    return Math.max(0, Math.min(100, raw.usedPercent));
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function cleanGroupName(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+models$/i, "").trim();
  return cleaned || raw;
}

function cleanBucketName(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+limit\s+remaining$/i, "").replace(/\s+(?:limit|remaining)$/i, "").trim();
  return cleaned || raw;
}

function bucketLabel(groupName: string | null, bucketName: string | null, window: string | null, bucketId: string | null, index: number): string {
  const group = cleanGroupName(groupName);
  const bucket = cleanBucketName(bucketName);
  if (group && bucket) {
    if (bucket.toLowerCase().startsWith(group.toLowerCase())) return bucket;
    return `${group} · ${bucket}`;
  }
  if (bucket) return bucket;
  if (group && window) return `${group} · ${window}`;
  return bucketId ?? group ?? `Window ${index + 1}`;
}

/** Parse `ps -ax -o pid=,ppid=,command=` output for running Antigravity
 *  language servers (`agy` CLI or Antigravity's `language_server_*` binary)
 *  carrying `--csrf_token`. Wrapper processes (`tmux`, `python`, `script`)
 *  and non-Antigravity servers (Windsurf/Codeium) are ignored. */
export function parseLanguageServers(psOutput: string): LanguageServerProcess[] {
  const servers: LanguageServerProcess[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[3];
    const argv0 = command.trim().split(/\s+/)[0] ?? "";
    const base = argv0.split("/").pop() ?? "";
    const isAgy = base === "agy";
    const isAntigravityLs = /^language_server/i.test(base) && /antigravity|agy/i.test(command);
    if (!isAgy && !isAntigravityLs) continue;
    const tokenMatch = command.match(/--csrf_token(?:=|\s+)([^\s]+)/);
    if (!tokenMatch?.[1]) continue;
    const extMatch = command.match(/--extension_server_port(?:=|\s+)(\d+)/);
    const extensionPort = extMatch ? Number(extMatch[1]) : null;
    servers.push({
      pid,
      ppid,
      csrfToken: tokenMatch[1],
      extensionPort: extensionPort && extensionPort > 0 && extensionPort <= 65535 ? extensionPort : null,
    });
  }
  return servers;
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` output for listening
 *  loopback TCP ports. */
export function parseListeningPorts(lsofOutput: string): number[] {
  const ports = new Set<number>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    const m = line.match(/(?:127\.0\.0\.1|localhost|\[::1\]|\*):(\d+)\s+\(LISTEN\)/);
    if (!m) continue;
    const port = Number(m[1]);
    if (port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

/** Parse `RetrieveUserQuotaSummary` JSON into an `AgentQuota` snapshot. */
export function parseQuotaSummary(payload: Json | null | undefined, now = Date.now()): AgentQuota | null {
  const root = (payload?.response ?? payload?.quotaSummary ?? payload) as Json | undefined;
  const groups = Array.isArray(root?.groups) ? (root.groups as Json[]) : null;
  if (!groups) return null;
  const windows: QuotaWindow[] = [];
  for (const group of groups) {
    const groupName = str(group?.displayName);
    const buckets = Array.isArray(group?.buckets) ? (group.buckets as Json[]) : [];
    for (const bucket of buckets) {
      const used = usedPercentFrom(bucket);
      if (used === null) continue;
      const label = bucketLabel(groupName, str(bucket?.displayName), str(bucket?.window), str(bucket?.bucketId), windows.length);
      windows.push({
        label,
        used_percent: used,
        resets_ms: ms(bucket?.resetTime ?? bucket?.resetsAt),
      });
    }
  }
  if (!windows.length) return null;
  const plan = str(root?.planName) ?? str(payload?.planName);
  return {
    agent: "google",
    source: "Antigravity",
    as_of_ms: now,
    stale: windows.some((w) => w.resets_ms !== null && w.resets_ms < now),
    plan,
    windows,
    note: null,
  };
}

/** Parse `GetUserStatus` JSON fallback into an `AgentQuota` snapshot. */
export function parseUserStatus(payload: Json | null | undefined, now = Date.now()): AgentQuota | null {
  const userStatus = (payload?.userStatus ?? payload) as Json | undefined;
  const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs)) return null;
  const seen = new Set<string>();
  const windows: QuotaWindow[] = [];
  for (const cfg of configs as Json[]) {
    const used = usedPercentFrom(cfg?.quotaInfo);
    if (used === null) continue;
    const label = str(cfg?.label) ?? str(cfg?.modelOrAlias?.model) ?? `Model ${windows.length + 1}`;
    if (seen.has(label)) continue;
    seen.add(label);
    windows.push({
      label,
      used_percent: used,
      resets_ms: ms(cfg?.quotaInfo?.resetTime),
    });
  }
  if (!windows.length) return null;
  const planInfo = userStatus?.planStatus?.planInfo as Json | undefined;
  const plan = str(planInfo?.planDisplayName) ?? str(planInfo?.planName);
  return {
    agent: "google",
    source: "Antigravity",
    as_of_ms: now,
    stale: windows.some((w) => w.resets_ms !== null && w.resets_ms < now),
    plan,
    windows,
    note: null,
  };
}

function requestJson(
  protocol: "https" | "http",
  port: number,
  path: string,
  csrfToken: string,
  payload: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: Json | null }> {
  return new Promise((resolve, reject) => {
    const mod = protocol === "https" ? https : http;
    const req = mod.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": csrfToken,
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
        ...(protocol === "https" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status !== 200) return resolve({ ok: false, status, data: null });
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve({ ok: true, status, data: parsed && typeof parsed === "object" ? (parsed as Json) : null });
          } catch {
            resolve({ ok: false, status, data: null });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

/** POST a Connect-RPC JSON request to a local Antigravity language server port
 *  (HTTPS with self-signed loopback cert first, plain HTTP fallback). */
export async function postConnectJson(
  port: number,
  path: string,
  csrfToken: string,
  body: Json,
  timeoutMs = 2500,
): Promise<Json | null> {
  const payload = JSON.stringify(body);
  try {
    const res = await requestJson("https", port, path, csrfToken, payload, timeoutMs);
    return res.ok ? res.data : null;
  } catch {
    try {
      const res = await requestJson("http", port, path, csrfToken, payload, timeoutMs);
      return res.ok ? res.data : null;
    } catch {
      return null;
    }
  }
}

export async function listAntigravityServers(run: Run = runAsync): Promise<LanguageServerProcess[]> {
  try {
    const out = await run("ps", ["-ax", "-o", "pid=,ppid=,command="], { timeout: 3000, allowFailure: true });
    return parseLanguageServers(out);
  } catch {
    return [];
  }
}

export async function listListeningPorts(pid: number, run: Run = runAsync): Promise<number[]> {
  try {
    const out = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)], { timeout: 3000, allowFailure: true });
    return parseListeningPorts(out);
  } catch {
    return [];
  }
}

export async function probeLanguageServer(
  server: LanguageServerProcess,
  options: { listPorts?: (pid: number) => Promise<number[]>; post?: RpcPost; now?: number } = {},
): Promise<AgentQuota | null> {
  const now = options.now ?? Date.now();
  const post = options.post ?? postConnectJson;
  const ports = [...(await (options.listPorts ?? listListeningPorts)(server.pid))];
  if (server.extensionPort && !ports.includes(server.extensionPort)) ports.push(server.extensionPort);
  for (const port of ports) {
    const summary = parseQuotaSummary(await post(port, QUOTA_SUMMARY_PATH, server.csrfToken, {}), now);
    if (summary) return summary;
    const status = parseUserStatus(
      await post(port, USER_STATUS_PATH, server.csrfToken, {
        metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" },
      }),
      now,
    );
    if (status) return status;
  }
  return null;
}

export function resolveAgy(): string | null {
  const override = process.env.ANTIGRAVITY_CLI_PATH?.trim();
  if (override) {
    try {
      accessSync(override, constants.X_OK);
      return override;
    } catch {
      // Fall through to PATH / standard install directories.
    }
  }
  const home = homedir();
  return resolveExecutable("agy", [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]);
}

/** Start `agy` inside a temporary PTY with an explicit `--csrf_token` so it
 *  boots its embedded language server without an interactive terminal.
 *  `AGY_CLI_DISABLE_AUTO_UPDATE=true` prevents background auto-updates during
 *  passive quota checks. */
export function startAgy(executable: string, csrfToken = randomUUID()): SpawnedAgy {
  const python = resolveExecutable("python3", ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"]) ?? "python3";
  const child = spawn(python, ["-c", PTY_HELPER, executable, `--csrf_token=${csrfToken}`], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  });
  child.on("error", () => undefined);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    }
    const killer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }, 500);
    killer.unref();
  };

  return { pid: child.pid, csrfToken, stop };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface GoogleQuotaOptions {
  listServers?: () => Promise<LanguageServerProcess[]>;
  listPorts?: (pid: number) => Promise<number[]>;
  post?: RpcPost;
  agyExecutable?: string | null;
  spawnAgy?: (executable: string) => SpawnedAgy;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: number;
}

/** Query Antigravity's local language server for Google quota. If none is
 *  running, temporarily start `agy`, wait for its language server, probe it,
 *  and stop the temporary `agy` process. */
export async function googleQuota(options: GoogleQuotaOptions = {}): Promise<AgentQuota> {
  const now = options.now ?? Date.now();
  const listServers = options.listServers ?? (() => listAntigravityServers());
  const probe = (server: LanguageServerProcess) =>
    probeLanguageServer(server, { listPorts: options.listPorts, post: options.post, now });

  const existing = await listServers();
  for (const server of existing) {
    const quota = await probe(server);
    if (quota) return quota;
  }

  const agy = options.agyExecutable === undefined ? resolveAgy() : options.agyExecutable;
  if (!agy) return emptyGoogleQuota("Install Antigravity CLI (agy) or start Antigravity to see Google quota.");

  const existingPids = new Set(existing.map((s) => s.pid));
  const wait = options.sleep ?? sleep;
  const startTimeoutMs = options.startTimeoutMs ?? 6000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const handle = (options.spawnAgy ?? startAgy)(agy);
  try {
    const deadline = Date.now() + startTimeoutMs;
    while (true) {
      await wait(pollIntervalMs);
      const current = await listServers();
      const ordered = [
        ...current.filter((s) => s.csrfToken === handle.csrfToken),
        ...current.filter((s) => s.csrfToken !== handle.csrfToken && !existingPids.has(s.pid)),
        ...current.filter((s) => s.csrfToken !== handle.csrfToken && existingPids.has(s.pid)),
      ];
      for (const server of ordered) {
        const quota = await probe(server);
        if (quota) return quota;
      }
      if (Date.now() >= deadline) break;
    }
  } finally {
    await handle.stop();
  }

  return emptyGoogleQuota("Antigravity language server did not report quota — sign in with agy to see Google quota.");
}

/** One Antigravity probe per minute, shared by concurrent polls. */
export class GoogleQuotaCache extends QuotaCache {
  constructor(options: { fetchQuota?: () => Promise<AgentQuota>; clock?: () => number } = {}) {
    super({
      fetchQuota: options.fetchQuota ?? (() => googleQuota()),
      empty: emptyGoogleQuota,
      errorNote: "Could not reach Antigravity for Google quota.",
      slowNote: "Google quota is slow — retrying shortly.",
      clock: options.clock,
      timeoutMs: 10_000,
    });
  }
}
