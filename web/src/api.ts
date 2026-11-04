// Typed HTTP client for the Corral API. Cookie auth (same-origin credentials).
// Any 401 surfaces an "unauthorized" state through setUnauthorizedHandler.

import type { Config, Idea, Item, JiraImportResult, JiraSearchResult, Pull, Repo, SessionInfo, Task, UsageRange, UsageReport } from "./types";

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

export function setCacheStateHandler(handler: CacheStateHandler | null): void {
  cacheStateHandler = handler;
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    const init: RequestInit = { method, credentials: "same-origin" };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    res = await fetch(path, init);
    if (method === "GET") cacheStateHandler?.(res.headers.get("X-Corral-Cache") !== null);
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
  jiraImport: (items: { key: string; fingerprint: string }[]): Promise<JiraImportResult> =>
    post<JiraImportResult>("/api/jira/import", { items }),
  jiraDone: (taskId: string, transitionId?: string): Promise<{ ok: boolean; transition: string }> =>
    post<{ ok: boolean; transition: string }>(`/api/jira/tasks/${taskId}/done`, { transition_id: transitionId }),
  jiraComment: (taskId: string, text: string): Promise<{ ok: boolean }> =>
    post<{ ok: boolean }>(`/api/jira/tasks/${taskId}/comment`, { text }),

  // ---- ideas ----
  listIdeas: (status?: Idea["status"]): Promise<Idea[]> =>
    get<Idea[]>(`/api/ideas${query({ status })}`),
  createIdea: (input: { text: string; tag?: Idea["tag"]; origin?: Idea["origin"] }): Promise<Idea> =>
    post<Idea>("/api/ideas", input),
  patchIdea: (id: string, input: { status?: Idea["status"]; tag?: Idea["tag"] }): Promise<{ ok: boolean }> =>
    patch<{ ok: boolean }>(`/api/ideas/${id}`, input),

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

  // ---- misc ----
  getUsage: (range: UsageRange, refresh = false): Promise<UsageReport> =>
    get<UsageReport>(`/api/usage?range=${range}${refresh ? "&refresh=1" : ""}`),

  getConfig: (): Promise<Config> => get<Config>("/api/config"),
  putConfig: (input: { jira?: JiraConfigInput }): Promise<{ ok: boolean }> =>
    put<{ ok: boolean }>("/api/config", input),
};

// ---- SSE live updates ----

export type ServerEvent =
  | { type: "item.created"; item: Item }
  | { type: "item.updated"; item: Item }
  | { type: "task.updated"; task: Task }
  | { type: "idea.created"; idea: Idea }
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
  const onIdeaCreated = (ev: Event) => {
    const idea = parse(ev) as Idea | null;
    if (idea) onEvent({ type: "idea.created", idea });
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
  source.addEventListener("idea.created", onIdeaCreated);

  return () => {
    source.removeEventListener("item.created", onItemCreated);
    source.removeEventListener("item.updated", onItemUpdated);
    source.removeEventListener("task.updated", onTaskUpdated);
    source.removeEventListener("idea.created", onIdeaCreated);
    source.removeEventListener("pulls.updated", onPullsUpdated);
    source.removeEventListener("session.updated", onSessionUpdated);
    source.close();
  };
}
