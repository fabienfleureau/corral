// Omnigent worker backend: Corral as a client of omnigent's REST API
// (/v1/sessions …). Worktrees are delegated to omnigent (git options on
// session create — its host daemon runs `git worktree add`). Events come from
// a tolerant polling loop rather than per-session streams: fewer moving parts,
// same information (status, blocked elicitations, tree).

import type { OmnigentConfig } from "./config.ts";
import type {
  WorkerBackend,
  WorkerElicitation,
  WorkerEvent,
  WorkerEventSubscription,
  WorkerSession,
  WorkerStart,
} from "./worker.ts";

const POLL_MS = 4000;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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

function normalizeElicitations(raw: unknown): WorkerElicitation[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkerElicitation[] = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const params = (e.params ?? e.request ?? e) as Record<string, unknown>;
    const id = str(e.elicitation_id) ?? str(e.id) ?? str(params.elicitation_id);
    if (!id) continue;
    const rawKind = (str(e.kind) ?? str(e.type) ?? str(params.type) ?? str(params.kind) ?? "").toLowerCase();
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
    out.push({ id, kind, prompt: prompt.slice(0, 4000), choices });
  }
  return out;
}

export class OmnigentBackend implements WorkerBackend {
  name = "omnigent";
  private cfg: OmnigentConfig;
  private last = new Map<string, string>(); // address -> signature of status/elicitations
  private timer: ReturnType<typeof setInterval> | null = null;
  private subs = new Set<(e: WorkerEvent) => void>();
  private taskIds = new Map<string, string | null>();

  constructor(cfg: OmnigentConfig) {
    this.cfg = cfg;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(new URL(path, this.cfg.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`omnigent ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ---- normalization ----

  private normalize(raw: Record<string, unknown>): WorkerSession {
    const id = str(raw.id) ?? str(raw.session_id) ?? "";
    const labels = (raw.labels ?? {}) as Record<string, unknown>;
    const elicitations = normalizeElicitations(raw.pending_elicitations ?? []);
    const pendingCount = num(raw.pending_elicitations_count) ?? elicitations.length;
    const live = str(raw.live_status) ?? str(raw.status) ?? null;
    return {
      address: id,
      task_id: str(labels["corral.task"]) ?? this.taskIds.get(id) ?? null,
      name: str(raw.title) ?? str(raw.sub_agent_name),
      harness: str(labels["corral.harness"]) ?? null,
      status: normalizeStatus(live, pendingCount > 0 || elicitations.length > 0),
      blocked_kind: elicitations[0]?.kind ?? (pendingCount > 0 ? "question" : null),
      state: raw.archived === true ? "finished" : "live",
      turn: num(raw.turn) ?? num(raw.response_count) ?? 0,
      cwd: str(raw.workspace) ?? str(raw.cwd) ?? "",
      created_ms: num(raw.created_ms) ?? num(raw.created_at) ?? Date.now(),
      exit_code: live === "failed" ? 1 : null,
      parent: str(raw.parent_session_id),
    };
  }

  async start(start: WorkerStart): Promise<WorkerSession> {
    const agentCfg = this.cfg.agents[start.harness];
    const agentId = agentCfg?.agentId ?? start.harness;
    const body: Record<string, unknown> = {
      agent_id: agentId,
      title: start.name,
      labels: {
        "corral.task": start.taskId ?? "",
        "corral.harness": start.harness,
      },
      workspace: start.repoPath,
    };
    if (start.git) {
      // omnigent's host daemon creates the worktree (`<repo>-worktrees/<branch>`)
      body.git = {
        branch_name: start.git.branch,
        ...(start.git.base ? { base_branch: start.git.base } : {}),
        ...(start.git.existingWorktree ? { existing_worktree: true } : {}),
      };
    }
    if (this.cfg.hostId) body.host_id = this.cfg.hostId;
    if (agentCfg?.harness) body.harness_override = agentCfg.harness;
    if (start.model) body.model_override = start.model;
    if (start.reasoning) body.reasoning_effort = start.reasoning;
    body.initial_input = {
      type: "message",
      data: { role: "user", content: [{ type: "input_text", text: start.prompt }] },
    };
    const created = await this.request<Record<string, unknown>>("POST", "/v1/sessions", body);
    const session = this.normalize(created);
    if (start.taskId) this.taskIds.set(session.address, start.taskId);
    return session;
  }

  async list(): Promise<WorkerSession[]> {
    const res = await this.request<Record<string, unknown>>("GET", "/v1/sessions?limit=200");
    const rows = (res.data ?? res.sessions ?? res) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => this.normalize(r as Record<string, unknown>));
  }

  async get(address: string): Promise<WorkerSession | null> {
    try {
      const raw = await this.request<Record<string, unknown>>("GET", `/v1/sessions/${address}`);
      return this.normalize(raw);
    } catch {
      return null;
    }
  }

  async read(address: string, lines: number): Promise<string> {
    // Conversation history doubles as "recent output" — cleaner than raw
    // terminal capture and it survives across sessions.
    const text = await this.history(address);
    const split = text.split("\n");
    return split.slice(Math.max(0, split.length - lines)).join("\n");
  }

  async send(address: string, text: string): Promise<void> {
    await this.request("POST", `/v1/sessions/${address}/events`, {
      type: "message",
      data: { role: "user", content: [{ type: "input_text", text }] },
    });
  }

  async resolveElicitation(
    address: string,
    elicitationId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      "POST",
      `/v1/sessions/${address}/elicitations/${encodeURIComponent(elicitationId)}/resolve`,
      content ? { action, content } : { action },
    );
  }

  async kill(address: string): Promise<void> {
    try {
      await this.request("POST", `/v1/sessions/${address}/interrupt`, {});
    } catch {
      /* interrupt is best effort */
    }
    try {
      await this.request("PATCH", `/v1/sessions/${address}`, { archived: true });
    } catch {
      /* archive is best effort */
    }
  }

  async cleanup(address: string): Promise<void> {
    // omnigent removes the worktree with the session (delete_branch=true).
    try {
      await this.request("DELETE", `/v1/sessions/${address}?delete_branch=true`);
    } catch {
      await this.request("DELETE", `/v1/sessions/${address}`);
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
    // Best-effort deep link into omnigent's own UI ("how the agent worked").
    return `${this.cfg.baseUrl.replace(/\/$/, "")}/sessions/${address}`;
  }

  // ---- events via polling ----

  private async tick(): Promise<void> {
    let sessions: WorkerSession[] = [];
    try {
      sessions = await this.list();
    } catch {
      return; // server unreachable — keep polling
    }
    for (const s of sessions) {
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
      } else if (prev !== sig) {
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
    const seen = new Set(sessions.map((s) => s.address));
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
