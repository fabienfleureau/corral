import type { EpicAgentSettings, EpicAgentView } from "../../shared/epic-agent";
import type { KpiArtifactRequest } from "../../shared/kpi-artifact";
import type { KpiId, KpiSettings, KpiView } from "../../shared/kpis";
import type { ImprovementMetrics } from "../../shared/improvement-metrics";
// Typed HTTP client for the Corral API. Cookie auth (same-origin credentials).
// Any 401 surfaces an "unauthorized" state through setUnauthorizedHandler.

import type { AttachmentInput } from "./attachments";
import type { AgentQuota, Config, DailyActivity, Epic, EpicDetail, EpicSummary, Item, JiraImportResult, JiraSearchResult, ModelAvailability, ModelCatalog, PlanReview, PlanReviewComment, PlanRevisionsResponse, PlatformRateLimit, Pull, Repo, SessionInfo, Task, TaskEvent, TrackedTerminal, UsageRange, UsageReport } from "./types";

/** Schedule and run state of a server-side analysis (improvement, skills). */
export type AnalysisStatus = { intervalDays: number; lastSuccessMs: number | null; lastAttemptMs: number | null; error: string | null; running: boolean };

export class ApiError extends Error {
  readonly status: number;
  readonly data?: Record<string, unknown>;

  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
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
    let errorData: Record<string, unknown> | undefined;
    try {
      const data = (await res.json()) as Record<string, unknown>;
      if (data && typeof data === "object") {
        errorData = data;
        if (typeof data.error === "string") message = data.error;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, errorData);
  }
  if (method !== "GET") mutationVersion++;
  try {
    return (await res.json()) as T;
  } catch {
    // A 2xx that is not JSON did not come from the API: an older server
    // process serving the SPA shell for an unimplemented route, or a body cut
    // short. Say that, instead of leaking the browser's JSON.parse message.
    const type = res.headers.get("content-type") ?? "no content type";
    throw new ApiError(
      res.status,
      `${method} ${path} returned ${type} instead of JSON (HTTP ${res.status}). The server may be older than this page — restart it and reload.`,
    );
  }
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

// An old server answers the epic routes with valid JSON in an older shape
// (`{epic, tasks, links}` or rows with `task_count`). The typed client trusts
// it, then the page crashes on `detail.views.map` and React renders nothing.
function staleEpicResponse(method: string, path: string): ApiError {
  return new ApiError(200, `${method} ${path} returned an old epic response. The Corral server is older than this page — restart it and reload.`);
}

function checkEpicDetail<T>(value: T, method: string, path: string): T {
  const d = value as EpicDetail | null;
  if (!d || !Array.isArray(d.views) || !d.summary || typeof d.summary.total !== "number") throw staleEpicResponse(method, path);
  return value;
}

export type DispatchResult = {
  address: string;
  worktreePath: string;
  branch: string;
};

/** Work a PR check handed to the agent (a forced refresh reports it). */
export type PrDelivery = { address: string | null; comments: boolean; conflict: boolean; checks?: boolean };

export type CheckPrResult = {
  pr: unknown;
  task: Task;
  delivered: PrDelivery | null;
};

export type NewTaskInput = {
  /** Omit to let omnigent title the session after dispatch. */
  title?: string;
  prompt?: string;
  /** Files sent to the agent with the prompt (see web/src/attachments.ts). */
  attachments?: AttachmentInput[];
  kind?: "code" | "review" | "spec" | "ops" | "grill" | "grill-docs";
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
  replyItem: (id: string, text: string): Promise<{ ok: boolean; sent_to: string; item?: Item }> =>
    post<{ ok: boolean; sent_to: string; item?: Item }>(`/api/items/${id}/reply`, { text }),
  replyPermission: (id: string, permission: string): Promise<{ ok: boolean; sent_to: string; item?: Item }> =>
    post<{ ok: boolean; sent_to: string; item?: Item }>(`/api/items/${id}/reply`, { permission }),
  replyAnswers: (id: string, content: Record<string, string | string[]>): Promise<{ ok: boolean; sent_to: string; item?: Item }> =>
    post<{ ok: boolean; sent_to: string; item?: Item }>(`/api/items/${id}/reply`, { content }),
  summarizeItem: (id: string): Promise<Item> => post<Item>(`/api/items/${id}/summarize`),
  resolveItem: (id: string): Promise<Item> => post<Item>(`/api/items/${id}/resolve`),
  archiveItem: (id: string): Promise<Item> => post<Item>(`/api/items/${id}/archive`),
  syncPrs: (): Promise<{ ok: boolean; ran: boolean }> => post<{ ok: boolean; ran: boolean }>("/api/prs/sync"),
  snoozeItem: (id: string, untilMs: number): Promise<Item> =>
    post<Item>(`/api/items/${id}/snooze`, { until_ms: untilMs }),

  // ---- epics ----
  listEpics: async (): Promise<(Epic & { summary: EpicSummary })[]> => {
    const rows = await get<(Epic & { summary: EpicSummary })[]>("/api/epics");
    if (!Array.isArray(rows) || rows.some((r) => !r?.summary || typeof r.summary.total !== "number")) throw staleEpicResponse("GET", "/api/epics");
    return rows;
  },
  orchestrateEpic: (id: string, request: string): Promise<{ proposal: string }> => post(`/api/epics/${id}/orchestrate`, { request }),
  patchEpicSettings: async (id: string, input: { favorite_name: string; repo_path: string }): Promise<EpicDetail> =>
    checkEpicDetail(await patch(`/api/epics/${id}`, input), "PATCH", `/api/epics/${id}`),
  createEpicRequest: (id: string, input: { request: string; favorite_name: string; repo_path: string; kind?: "code" | "ops" }): Promise<Task> =>
    post(`/api/epics/${id}/requests`, input),
  getEpic: async (id: string): Promise<EpicDetail> => checkEpicDetail(await get(`/api/epics/${id}`), "GET", `/api/epics/${id}`),
  getEpicAgent: (id: string): Promise<EpicAgentView> => get(`/api/epics/${id}/agent`),
  configureEpicAgent: (id: string, settings: EpicAgentSettings): Promise<EpicAgentView> => put(`/api/epics/${id}/agent`, settings),
  runEpicAgent: (id: string, instruction?: string): Promise<EpicAgentView> =>
    post(`/api/epics/${id}/agent/run`, instruction ? { instruction } : undefined),
  importEpic: async (key: string): Promise<EpicDetail> => checkEpicDetail(await post("/api/epics", { key }), "POST", "/api/epics"),
  syncEpic: async (id: string): Promise<EpicDetail> => checkEpicDetail(await post(`/api/epics/${id}/sync`), "POST", `/api/epics/${id}/sync`),
  launchEpicTask: (epicId: string, taskId: string): Promise<DispatchResult> =>
    post<DispatchResult>(`/api/epics/${epicId}/tasks/${taskId}/launch`),
  reviseDesign: async (id: string, input: { body: string; reason: string }): Promise<EpicDetail> =>
    checkEpicDetail(await post(`/api/epics/${id}/design`, input), "POST", `/api/epics/${id}/design`),
  applyAmendment: (itemId: string): Promise<Item> => post(`/api/items/${itemId}/amendment/apply`),
  rejectAmendment: (itemId: string): Promise<Item> => post(`/api/items/${itemId}/amendment/reject`),

  // ---- tasks ----
  progression: (): Promise<{ xp: number; level: number; levelXp: number; nextLevelXp: number; tasks: number; inbox: number }> => get("/api/progression"),
  dailyActivity: (start: number, end: number): Promise<DailyActivity[]> => get(`/api/daily${query({ start: String(start), end: String(end) })}`),
  summarizeDaily: (input: { start: number; end: number; date: string; favorite: string }): Promise<{ task: Task }> => post("/api/daily/summarize", input),
  listTasks: (status?: Task["status"]): Promise<Task[]> =>
    get<Task[]>(`/api/tasks${query({ status })}`),
  createTask: (input: NewTaskInput): Promise<Task> => post<Task>("/api/tasks", input),
  getPlanRevisions: (taskId: string): Promise<PlanRevisionsResponse> =>
    get<PlanRevisionsResponse>(`/api/tasks/${taskId}/plan-revisions`),
  requestPlanChanges: (
    taskId: string,
    input: { revision_id: string; note?: string; comments?: PlanReviewComment[] },
  ): Promise<{ review: PlanReview; item: Item | null; sent_to: string }> =>
    post<{ review: PlanReview; item: Item | null; sent_to: string }>(`/api/tasks/${taskId}/request-plan-changes`, input),
  approvePlan: (taskId: string, revisionId?: string): Promise<{ children: Task[] }> =>
    post<{ children: Task[] }>(`/api/tasks/${taskId}/approve-plan`, revisionId ? { revision_id: revisionId } : undefined),
  patchTask: (id: string, input: Partial<Task>): Promise<Task> => patch<Task>(`/api/tasks/${id}`, input),
  requestArtifact: (id: string): Promise<{ ok: boolean }> => post(`/api/tasks/${id}/artifact`),
  /** Archive a task with its session when it has one; otherwise just archive the task. */
  archiveTask: (task: Pick<Task, "id" | "terminal_address">): Promise<Task> => task.terminal_address
    ? post<Task>(`/api/tasks/${task.id}/archive-session`)
    : patch<Task>(`/api/tasks/${task.id}`, { status: "archived" }),
  dispatchTask: (
    id: string,
    input: { target?: string; use_worktree?: boolean; agent?: string | null; model?: string | null; reasoning?: string | null; review?: string | null },
  ): Promise<DispatchResult> =>
    post<DispatchResult>(`/api/tasks/${id}/dispatch`, input),
  cleanupTask: (id: string): Promise<{ ok: boolean }> => post<{ ok: boolean }>(`/api/tasks/${id}/cleanup`),
  taskEvents: (id: string): Promise<TaskEvent[]> => get<TaskEvent[]>(`/api/tasks/${id}/events`),
  /** Read a local Markdown file referenced in a task description. */
  markdownFile: (path: string): Promise<{ path: string; content: string }> =>
    get<{ path: string; content: string }>(`/api/markdown-file?path=${encodeURIComponent(path)}`),
  checkPr: (id: string, opts: { force?: boolean } = {}): Promise<CheckPrResult> =>
    post<CheckPrResult>(`/api/tasks/${id}/check-pr`, opts.force ? { force: true } : undefined),

  // ---- jira ----
  jiraSearch: (q: string): Promise<JiraSearchResult[]> =>
    get<JiraSearchResult[]>(`/api/jira/search${query({ q })}`),
  jiraImport: (items: { key: string; fingerprint: string; repo_path?: string; base_branch?: string | null; target?: string; agent?: string | null; model?: string | null; reasoning?: string | null }[]): Promise<JiraImportResult> =>
    post<JiraImportResult>("/api/jira/import", { items }),
  jiraDone: (taskId: string, transitionId?: string): Promise<{ ok: boolean; transition: string }> =>
    post<{ ok: boolean; transition: string }>(`/api/jira/tasks/${taskId}/done`, { transition_id: transitionId }),
  jiraComment: (taskId: string, text: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/api/jira/tasks/${taskId}/comment`, { text }),

  // ---- model facts ----
  getModels: (): Promise<{ models: ModelCatalog }> => get<{ models: ModelCatalog }>("/api/models"),
  getModelAvailability: (): Promise<{ providers: Record<string, ModelAvailability> }> =>
    get<{ providers: Record<string, ModelAvailability> }>("/api/models/availability"),

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
  listTerminals: (): Promise<TrackedTerminal[]> => get<TrackedTerminal[]>("/api/terminals"),
  openSession: (address: string): Promise<{ ok: boolean; opened: boolean; url?: string }> =>
    post<{ ok: boolean; opened: boolean; url?: string }>(`/api/terminals/${encodeURIComponent(address)}/open`),

  // ---- repos ----
  listRepos: (): Promise<Repo[]> => get<Repo[]>("/api/repos"),
  matchRepoForPull: (url: string): Promise<{ repo_path: string | null; repo_name: string | null; via: "remote" | "name" | null }> =>
    get(`/api/repos/match${query({ url })}`),
  addRepo: (input: { path: string; name?: string; jira_prefix?: string }): Promise<Repo> =>
    post<Repo>("/api/repos", input),
  patchRepo: (id: string, input: { name?: string; jira_prefix?: string | null; context?: Repo["context"] }): Promise<Repo> =>
    patch<Repo>(`/api/repos/${id}`, input),
  deleteRepo: (id: string): Promise<{ ok: boolean }> => request<{ ok: boolean }>(`/api/repos/${id}`, "DELETE"),
  scanRepos: (): Promise<{ added: Repo[]; total: number; roots: string[] }> =>
    post<{ added: Repo[]; total: number; roots: string[] }>("/api/repos/scan"),

  listErrors: (): Promise<{ source: string; message: string; updated_ms: number }[]> => get("/api/errors"),

  // ---- misc ----
  getUsage: (range: UsageRange, refresh = false): Promise<UsageReport> =>
    get<UsageReport>(`/api/usage?range=${range}${refresh ? "&refresh=1" : ""}`),

  getUsageQuota: (refresh = false): Promise<{ quota: AgentQuota[]; fetched_ms: number }> =>
    get<{ quota: AgentQuota[]; fetched_ms: number }>(`/api/usage/quota${refresh ? "?refresh=1" : ""}`),

  getRateLimits: (refresh = false): Promise<{ limits: PlatformRateLimit[]; fetched_ms: number }> =>
    get<{ limits: PlatformRateLimit[]; fetched_ms: number }>(`/api/rate-limits${refresh ? "?refresh=1" : ""}`),

  listKpis: (): Promise<KpiView[]> => get("/api/kpis"),
  configureKpi: (id: KpiId, settings: KpiSettings): Promise<KpiView> => put(`/api/kpis/${id}`, settings),
  runKpi: (id: KpiId, instruction?: string): Promise<KpiView> =>
    post(`/api/kpis/${id}/run`, instruction ? { instruction } : undefined),
  buildKpiArtifact: (id: KpiId, input: KpiArtifactRequest): Promise<{ task: Task }> =>
    post(`/api/kpis/${id}/artifact`, input),

  analysisRepo: (): Promise<{ repo: string }> => get<{ repo: string }>("/api/analysis-repo"),
  setAnalysisRepo: (repo: string): Promise<{ repo: string }> => put<{ repo: string }>("/api/analysis-repo", { repo }),
  engineeringSkillsStatus: (): Promise<AnalysisStatus> => get<AnalysisStatus>("/api/engineering-skills"),
  setEngineeringSkillsSchedule: (intervalDays: number): Promise<AnalysisStatus> => put<AnalysisStatus>("/api/engineering-skills", { intervalDays }),
  runEngineeringSkills: (): Promise<Task> => post<Task>("/api/engineering-skills/run"),
  improvementStatus: (): Promise<AnalysisStatus> => get<AnalysisStatus>("/api/improvement"),
  setImprovementSchedule: (intervalDays: number): Promise<AnalysisStatus> => put<AnalysisStatus>("/api/improvement", { intervalDays }),
  runImprovement: (): Promise<Task> => post<Task>("/api/improvement/run"),
  improvementMetrics: (opts: { days?: number; pivot?: string; waitDays?: number } = {}): Promise<ImprovementMetrics> => {
    const q = new URLSearchParams();
    if (opts.days) q.set("days", String(opts.days));
    if (opts.pivot) q.set("pivot", opts.pivot);
    if (opts.waitDays) q.set("wait_days", String(opts.waitDays));
    const qs = q.toString();
    return get<ImprovementMetrics>(`/api/improvement/metrics${qs ? `?${qs}` : ""}`);
  },
  skillsAnalysisStatus: (): Promise<AnalysisStatus> => get<AnalysisStatus>("/api/skills-analysis"),
  setSkillsAnalysisSchedule: (intervalDays: number): Promise<AnalysisStatus> => put<AnalysisStatus>("/api/skills-analysis", { intervalDays }),
  runSkillsAnalysis: (): Promise<Task> => post<Task>("/api/skills-analysis/run"),
  getConfig: (): Promise<Config> => get<Config>("/api/config"),
  putConfig: (input: { jira?: JiraConfigInput; favorites?: import("./types").Favorite[]; reviewers?: import("./types").Reviewer[]; models?: ModelCatalog }): Promise<{ ok: boolean }> =>
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
