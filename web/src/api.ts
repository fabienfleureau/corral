type ImprovementStatus = { intervalDays: number; lastSuccessMs: number | null; lastAttemptMs: number | null; error: string | null; running: boolean };
import type { BenchmarkSnapshot } from "./types";
// Typed HTTP client for the Corral API. Cookie auth (same-origin credentials).
// Any 401 surfaces an "unauthorized" state through setUnauthorizedHandler.

import type { Config, Item, JiraImportResult, JiraSearchResult, Pull, Repo, SessionInfo, Task, UsageRange, UsageReport } from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

// The service worker marks stale API responses with X-Corral-Cache: hit
// (server unreachable or slow even though the browser is online).
type CacheStateHandler = (stale: boolean) => void;
let cacheStateHandler: CacheStateHandler | null = null;
let connectivityVersion = 0;
// Bumped on every successful mutation so subsequent GETs use a fresh cache key
// (defeating the service worker's stale cached responses).
let mutationVersion = 0;

export function setCacheStateHandler(handler: CacheStateHandler | null): void {
  cacheStateHandler = handler;
}

// Reads are idempotent: one retry turns a transient blip (network hiccup,
// gateway error, server still starting) into a slightly slower page instead of
// an error the human has to re-trigger by hand.
const RETRY_DELAY_MS = 250;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(path: string, init: RequestInit): Promise<Response> {
  const retry = init.method === "GET";
  try {
    const res = await fetch(path, init);
    if (retry && RETRYABLE_STATUS.has(res.status)) {
      await delay(RETRY_DELAY_MS);
      return await fetch(path, init);
    }
    return res;
  } catch (err) {
    if (!retry) throw err;
    await delay(RETRY_DELAY_MS);
    return await fetch(path, init);
  }
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    const init: RequestInit = { method, credentials: "same-origin" };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    const requestPath =
      method === "GET" && mutationVersion > 0
        ? `${path}${path.includes("?") ? "&" : "?"}_mv=${mutationVersion}`
        : path;
    res = await fetchWithRetry(requestPath, init);
    if (method === "GET") {
      const version = ++connectivityVersion;
      if (res.headers.has("X-Corral-Cache")) {
        // A slow endpoint can time out while the server remains reachable.
        void fetch("/api/health", { credentials: "same-origin" }).then(
          (health) => {
            if (version === connectivityVersion) cacheStateHandler?.(!health.ok || health.headers.has("X-Corral-Cache"));
          },
          () => { if (version === connectivityVersion) cacheStateHandler?.(true); },
        );
      } else {
        cacheStateHandler?.(false);
      }
    }
  } catch (err) {
    throw new ApiError(0, `network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data && typeof data.error === "string") message = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (method !== "GET") mutationVersion++;
  return (await res.json()) as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, "GET");
}
function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, "POST", body);
}
function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, "PATCH", body);
}
function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, "PUT", body);
}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") q.set(key, value);
  }
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

export type DispatchResult = {
  address: string;
  worktreePath: string;
  branch: string;
};

export type NewTaskInput = {
  /** Omit to let omnigent title the session after dispatch. */
  title?: string;
  prompt?: string;
  kind?: "code" | "review";
  /** Required for kind "review": the PR/MR to review. */
  pr_url?: string;
  repo_path?: string;
  target?: string;
  model?: string | null;
  reasoning?: string | null;
  base_branch?: string | null;
  assignee?: string | null;
  jira_key?: string | null;
  jira_url?: string | null;
  jira_parent_key?: string | null;
};

export type JiraConfigInput = {
  baseUrl?: string;
  email?: string;
  token?: string;
  jql?: string;
};

export const api = {
  // ---- inbox ----
  listItems: (params: { status?: Item["status"]; kind?: Item["kind"] } = {}): Promise<Item[]> =>
    get<Item[]>(`/api/items${query({ status: params.status, kind: params.kind })}`),
  replyItem: (id: string, text: string): Promise<{ ok: boolean; sent_to: string }> =>
    post<{ ok: boolean; sent_to: string }>(`/api/items/${id}/reply`, { text }),
  replyPermission: (id: string, permission: string): Promise<{ ok: boolean; sent_to: string }> =>
    post<{ ok: boolean; sent_to: string }>(`/api/items/${id}/reply`, { permission }),
  replyAnswers: (id: string, content: Record<string, string | string[]>): Promise<{ ok: boolean; sent_to: string }> =>
    post<{ ok: boolean; sent_to: string }>(`/api/items/${id}/reply`, { content }),
  summarizeItem: (id: string): Promise<Item> => post<Item>(`/api/items/${id}/summarize`),
  resolveItem: (id: string): Promise<Item> => post<Item>(`/api/items/${id}/resolve`),
  archiveItem: (id: string): Promise<Item> => post<Item>(`/api/items/${id}/archive`),
  syncPrs: (): Promise<{ ok: boolean; ran: boolean }> => post<{ ok: boolean; ran: boolean }>("/api/prs/sync"),
  snoozeItem: (id: string, untilMs: number): Promise<Item> =>
    post<Item>(`/api/items/${id}/snooze`, { until_ms: untilMs }),

  // ---- tasks ----
  listTasks: (status?: Task["status"]): Promise<Task[]> =>
    get<Task[]>(`/api/tasks${query({ status })}`),
  createTask: (input: NewTaskInput): Promise<Task> => post<Task>("/api/tasks", input),
  patchTask: (id: string, input: Partial<Task>): Promise<Task> => patch<Task>(`/api/tasks/${id}`, input),
  archiveTaskSession: (id: string): Promise<Task> => post<Task>(`/api/tasks/${id}/archive-session`),
  dispatchTask: (
    id: string,
    input: { target?: string; use_worktree?: boolean; agent?: string | null; model?: string | null; reasoning?: string | null },
  ): Promise<DispatchResult> =>
    post<DispatchResult>(`/api/tasks/${id}/dispatch`, input),
  cleanupTask: (id: string): Promise<{ ok: boolean }> => post<{ ok: boolean }>(`/api/tasks/${id}/cleanup`),
  checkPr: (id: string): Promise<{ pr: unknown; task: Task }> =>
    post<{ pr: unknown; task: Task }>(`/api/tasks/${id}/check-pr`),

  // ---- jira ----
  jiraSearch: (q: string): Promise<JiraSearchResult[]> =>
    get<JiraSearchResult[]>(`/api/jira/search${query({ q })}`),
  jiraImport: (items: { key: string; fingerprint: string; repo_path?: string; base_branch?: string | null; target?: string; agent?: string | null; model?: string | null; reasoning?: string | null }[]): Promise<JiraImportResult> =>
    post<JiraImportResult>("/api/jira/import", { items }),
  jiraDone: (taskId: string, transitionId?: string): Promise<{ ok: boolean; transition: string }> =>
    post<{ ok: boolean; transition: string }>(`/api/jira/tasks/${taskId}/done`, { transition_id: transitionId }),
  jiraComment: (taskId: string, text: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/api/jira/tasks/${taskId}/comment`, { text }),

  // ---- worker harnesses ----
  listHarnesses: (): Promise<{ harnesses: { harness: string; agents: { id: string; name: string }[]; models?: { id: string; label: string; reasoning: string[] }[] }[]; agents: { id: string; name: string }[] }> =>
    get<{ harnesses: { harness: string; agents: { id: string; name: string }[]; models?: { id: string; label: string; reasoning: string[] }[] }[]; agents: { id: string; name: string }[] }>("/api/harnesses"),

  // ---- pull requests ----
  listPulls: (): Promise<{ pulls: Pull[]; fetched_ms: number }> =>
    get<{ pulls: Pull[]; fetched_ms: number }>("/api/pulls"),
  refreshPulls: (): Promise<{ pulls: Pull[]; fetched_ms: number }> =>
    post<{ pulls: Pull[]; fetched_ms: number }>("/api/pulls/refresh"),

  // ---- sessions ----
  listSessions: (): Promise<SessionInfo[]> => get<SessionInfo[]>("/api/sessions"),
  openSession: (address: string): Promise<{ ok: boolean; opened: boolean; url?: string }> =>
    post<{ ok: boolean; opened: boolean; url?: string }>(`/api/terminals/${encodeURIComponent(address)}/open`),

  // ---- repos ----
  listRepos: (): Promise<Repo[]> => get<Repo[]>("/api/repos"),
  addRepo: (input: { path: string; name?: string; jira_prefix?: string }): Promise<Repo> =>
    post<Repo>("/api/repos", input),
  patchRepo: (id: string, input: { name?: string; jira_prefix?: string | null }): Promise<Repo> =>
    patch<Repo>(`/api/repos/${id}`, input),
  deleteRepo: (id: string): Promise<{ ok: boolean }> => request<{ ok: boolean }>(`/api/repos/${id}`, "DELETE"),
  scanRepos: (): Promise<{ added: Repo[]; total: number; roots: string[] }> =>
    post<{ added: Repo[]; total: number; roots: string[] }>("/api/repos/scan"),

  listErrors: (): Promise<{ source: string; message: string; updated_ms: number }[]> => get("/api/errors"),

  // ---- misc ----
  getUsage: (range: UsageRange, refresh = false): Promise<UsageReport> =>
    get<UsageReport>(`/api/usage?range=${range}${refresh ? "&refresh=1" : ""}`),

  getBenchmarks: (): Promise<BenchmarkSnapshot> => get<BenchmarkSnapshot>("/api/benchmarks"),
  syncBenchmarks: (): Promise<BenchmarkSnapshot> => post<BenchmarkSnapshot>("/api/benchmarks/sync"),
  improvementStatus: (): Promise<ImprovementStatus> => get<ImprovementStatus>("/api/improvement"),
  setImprovementSchedule: (intervalDays: number): Promise<ImprovementStatus> => put<ImprovementStatus>("/api/improvement", { intervalDays }),
  runImprovement: (): Promise<Item> => post<Item>("/api/improvement/run"),
  getConfig: (): Promise<Config> => get<Config>("/api/config"),
  putConfig: (input: { jira?: JiraConfigInput; favorites?: import("./types").Favorite[] }): Promise<{ ok: boolean }> =>
    put<{ ok: boolean }>("/api/config", input),
};

// ---- SSE live updates ----

export type ServerEvent =
  | { type: "item.created"; item: Item }
  | { type: "item.updated"; item: Item }
  | { type: "task.updated"; task: Task }
  | { type: "pulls.updated" }
  | { type: "session.updated"; address: string; status: string | null };

/** Subscribe to /api/events. Returns an unsubscribe function. */
export function subscribeEvents(onEvent: (event: ServerEvent) => void): () => void {
  const source = new EventSource("/api/events");

  const parse = (ev: Event): unknown => {
    try {
      return JSON.parse((ev as MessageEvent<string>).data);
    } catch {
      return null;
    }
  };

  const onItemCreated = (ev: Event) => {
    const item = parse(ev) as Item | null;
    if (item) onEvent({ type: "item.created", item });
  };
  const onItemUpdated = (ev: Event) => {
    const item = parse(ev) as Item | null;
    if (item) onEvent({ type: "item.updated", item });
  };
  const onTaskUpdated = (ev: Event) => {
    const task = parse(ev) as Task | null;
    if (task) onEvent({ type: "task.updated", task });
  };
  // Background refreshes and session status changes: pages just reload.
  const onPullsUpdated = () => onEvent({ type: "pulls.updated" });
  const onSessionUpdated = (ev: Event) => {
    const s = parse(ev) as { address?: string; status?: string | null } | null;
    if (s?.address) onEvent({ type: "session.updated", address: s.address, status: s.status ?? null });
  };

  source.addEventListener("item.created", onItemCreated);
  source.addEventListener("pulls.updated", onPullsUpdated);
  source.addEventListener("session.updated", onSessionUpdated);
  source.addEventListener("item.updated", onItemUpdated);
  source.addEventListener("task.updated", onTaskUpdated);

  return () => {
    source.removeEventListener("item.created", onItemCreated);
    source.removeEventListener("item.updated", onItemUpdated);
    source.removeEventListener("task.updated", onTaskUpdated);
    source.removeEventListener("pulls.updated", onPullsUpdated);
    source.removeEventListener("session.updated", onSessionUpdated);
    source.close();
  };
}
