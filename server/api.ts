// HTTP API + static hosting. Token auth middleware (token-ready for LAN/team),
// SSE hub for live inbox updates.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { WorkerBackend } from "./worker.ts";
import type { CaptureEngine, Hub } from "./capture.ts";
import type { JiraClient, JiraIssue } from "./jira.ts";
import { summarizeText } from "./llm.ts";
import { dispatchTask } from "./dispatch.ts";
import { addRepo, gitToplevel, importFingerprint, importPreview, jiraKeyPrefix, scanWorkspaceRepos } from "./repos.ts";
import { syncAllPrs, syncTaskPr } from "./pr.ts";
import { cachedPulls, refreshPulls } from "./pulls.ts";
import type { Idea, Item, Task } from "./types.ts";
import { taskLabel } from "./types.ts";
import { DEFAULT_PRICES, USAGE_RANGES, UsageScanner, buildReport, claudeQuota, codexQuota, defaultSources, type UsageRange } from "./usage.ts";

export interface AppState {
  db: Db;
  cfg: Config;
  backend: WorkerBackend;
  capture: CaptureEngine;
  jira: JiraClient;
  hub: Hub & { clients: Set<ServerResponse> };
  /** Agent usage scanner (Claude/Codex logs); created on first use when absent. */
  usage?: UsageScanner;
}

/** A Jira issue as the import would create it, plus the fingerprint of those fields. */
function jiraImportCandidate(state: AppState, issue: JiraIssue) {
  const f = state.jira.issueToTaskFields(issue);
  const preview = importPreview(state.db, f.jira_key);
  return { ...f, ...preview, fingerprint: importFingerprint({ ...f, repo_path: preview.repo_path }) };
}

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: { body: unknown; params: Record<string, string>; url: URL }) => void | Promise<void>;

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function tokenOf(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const q = url.searchParams.get("token");
  if (q) return q;
  const cookie = req.headers.cookie ?? "";
  const m = cookie.match(/corral_token=([^;]+)/);
  return m ? m[1] : null;
}

interface ItemElicitation {
  id: string;
  kind: string;
  field?: string | null;
}

function parseElicitation(raw: string | null | undefined): ItemElicitation | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as ItemElicitation;
    return e?.id ? e : null;
  } catch {
    return null;
  }
}

/** Map an inbox reply onto an elicitation verdict. Free text that is not a
 *  plain yes/no on a binary ask declines it and is forwarded as a message. */
export function elicitationVerdict(
  e: ItemElicitation,
  text: string,
): { action: "accept" | "decline"; content?: Record<string, unknown>; forward: boolean } {
  const t = text.trim().toLowerCase();
  if (e.field && e.kind !== "permission") return { action: "accept", content: { [e.field]: text.trim() }, forward: false };
  if (/^(y|yes|ok|allow|approve|accept|accepted)\b/.test(t)) return { action: "accept", forward: false };
  if (/^(n|no|deny|decline|reject|refuse)\b/.test(t)) return { action: "decline", forward: false };
  return { action: "decline", forward: true };
}

export function createHttpServer(state: AppState): ReturnType<typeof createServer> {
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

  const on = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:([A-Za-z_]+)/g, (_m, k: string) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "$",
    );
    routes.push({ method, pattern, keys, handler });
  };

  // ---- health (unauthenticated) ----
  on("GET", "/api/health", (_req, res) => json(res, 200, { ok: true, name: "corral" }));

  // ---- items (inbox) ----
  on("GET", "/api/items", (_req, res, { url }) => {
    const status = url.searchParams.get("status") ?? undefined;
    const kind = url.searchParams.get("kind") ?? undefined;
    json(res, 200, state.db.listItems({ status: status as never, kind: kind as never }));
  });

  on("POST", "/api/items/:id/reply", async (req, res, { body, params }) => {
    const item = state.db.getItem(params.id);
    if (!item) return json(res, 404, { error: "item not found" });
    const text = (body as { text?: string })?.text ?? "";
    if (!text.trim()) return json(res, 400, { error: "text required" });
    const address = item.source_ref ?? (item.task_id ? state.db.getTask(item.task_id)?.terminal_address : null);
    if (!address) return json(res, 409, { error: "no terminal linked to this item" });
    const elicitation = parseElicitation(item.elicitation);
    if (elicitation) {
      // A captured permission/question is answered on the elicitation itself;
      // a plain message would leave it pending in the backend.
      const verdict = elicitationVerdict(elicitation, text);
      await state.backend.resolveElicitation(address, elicitation.id, verdict.action, verdict.content);
      if (verdict.forward) await state.backend.send(address, text);
    } else {
      await state.backend.send(address, text);
    }
    state.db.updateItem(item.id, { status: "resolved", resolved_ms: Date.now() });
    state.db.recordMetric("item.replied", item.id, { address });
    state.hub.broadcast("item.updated", state.db.getItem(item.id));
    json(res, 200, { ok: true, sent_to: address });
  });

  on("POST", "/api/items/:id/summarize", async (_req, res, { params }) => {
    const item = state.db.getItem(params.id);
    if (!item) return json(res, 404, { error: "item not found" });
    const text = item.body || item.summary;
    try {
      const summary = await summarizeText(state.cfg, text, item.title);
      state.db.updateItem(item.id, { summary });
      state.hub.broadcast("item.updated", state.db.getItem(item.id));
      json(res, 200, state.db.getItem(item.id));
    } catch (err) {
      json(res, 502, { error: String(err) });
    }
  });

  on("POST", "/api/items/:id/resolve", (_req, res, { params }) => {
    state.db.updateItem(params.id, { status: "resolved", resolved_ms: Date.now() });
    state.db.recordMetric("item.resolved", params.id, { how: "manual" });
    state.hub.broadcast("item.updated", state.db.getItem(params.id));
    json(res, 200, state.db.getItem(params.id));
  });

  on("POST", "/api/items/:id/archive", (_req, res, { params }) => {
    state.db.updateItem(params.id, { status: "archived" });
    state.hub.broadcast("item.updated", state.db.getItem(params.id));
    json(res, 200, state.db.getItem(params.id));
  });

  on("POST", "/api/items/:id/snooze", (req, res, { body, params }) => {
    const until = Number((body as { until_ms?: number })?.until_ms ?? Date.now() + 3600_000);
    state.db.updateItem(params.id, { snooze_until_ms: until });
    state.db.recordMetric("item.snoozed", params.id, { until_ms: until });
    state.hub.broadcast("item.updated", state.db.getItem(params.id));
    json(res, 200, state.db.getItem(params.id));
  });

  // ---- tasks ----
  on("GET", "/api/tasks", (_req, res, { url }) => {
    const status = url.searchParams.get("status") ?? undefined;
    json(res, 200, state.db.listTasks(status as never));
  });

  on("POST", "/api/tasks", (req, res, { body }) => {
    const b = body as Partial<Task>;
    if (!b?.title?.trim() && !b?.prompt?.trim()) return json(res, 400, { error: "title or prompt required" });
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      // Empty title = adopt omnigent's session title once dispatched.
      title: b.title?.trim() ?? "",
      prompt: b.prompt ?? "",
      repo_path: b.repo_path ?? "",
      target: b.target ?? "",
      target_state: "suggested",
      base_branch: b.base_branch ?? null,
      branch: null,
      worktree_path: null,
      assignee: b.assignee ?? null,
      jira_key: b.jira_key ?? null,
      jira_url: b.jira_url ?? null,
      jira_parent_key: b.jira_parent_key ?? null,
      pr_url: null,
      pr_meta: null,
      status: "open",
      terminal_address: null,
      exit_code: null,
      created_ms: now,
      updated_ms: now,
    };
    state.db.insertTask(task);
    state.db.recordMetric("task.created", task.id, { source: b.jira_key ? "jira" : "manual" });
    state.hub.broadcast("task.updated", task);
    json(res, 200, task);
  });

  on("PATCH", "/api/tasks/:id", (req, res, { body, params }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    const patch = body as Partial<Task>;
    delete patch.id;
    state.db.updateTask(task.id, patch);
    state.hub.broadcast("task.updated", state.db.getTask(task.id));
    json(res, 200, state.db.getTask(task.id));
  });

  on("POST", "/api/tasks/:id/dispatch", async (req, res, { body, params }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    if (task.status === "dispatched") return json(res, 409, { error: "task already dispatched" });
    const b = (body ?? {}) as {
      target?: string;
      use_worktree?: boolean;
      model?: string | null;
      reasoning?: string | null;
      agent?: string | null;
    };
    const target = b.target ?? task.target;
    if (!target) return json(res, 400, { error: "target required (claude|codex|opencode)" });
    if (!task.repo_path?.trim()) return json(res, 400, { error: "task has no repo — assign one before dispatching" });
    try {
      const result = await dispatchTask(state.db, state.cfg, state.backend, task, target, {
        useWorktree: b.use_worktree,
        model: b.model ?? null,
        reasoning: b.reasoning ?? null,
        agent: b.agent ?? null,
      });
      state.hub.broadcast("task.updated", state.db.getTask(task.id));
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  on("POST", "/api/tasks/:id/cleanup", async (req, res, { params }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    if (!task.worktree_path) return json(res, 400, { error: "task has no worktree" });
    if (!task.terminal_address || !state.backend.cleanup) {
      json(res, 501, { error: "this backend cannot remove worktrees" });
      return;
    }
    try {
      await state.backend.cleanup(task.terminal_address);
      state.db.updateTask(task.id, { worktree_path: null });
      state.db.recordMetric("task.worktree_removed", task.id, {});
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  on("POST", "/api/tasks/:id/check-pr", async (req, res, { params }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    if (!task.branch) return json(res, 400, { error: "task has no branch (dispatch it first)" });
    try {
      const pr = await syncTaskPr(state.db, state.hub, task, { backend: state.backend, cfg: state.cfg });
      json(res, 200, { pr, task: state.db.getTask(task.id) });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  // Inbox open: re-check PRs so merged ones are archived before the human looks.
  on("POST", "/api/prs/sync", async (_req, res) => {
    const ran = await syncAllPrs(state.db, state.hub, { backend: state.backend, cfg: state.cfg, knownPrsOnly: true });
    json(res, 200, { ok: true, ran });
  });

  // ---- structured agent reports ----
  on("POST", "/api/reports", async (req, res, { body }) => {
    const b = body as {
      task_id?: string;
      terminal?: string;
      kind?: string;
      title?: string;
      body?: string;
      options?: string[];
    };
    if (!b?.title || !b?.body) return json(res, 400, { error: "title and body required" });
    const item = await state.capture.createStructuredQuestion({
      kind: b.kind ?? "question",
      taskId: b.task_id ?? null,
      terminal: b.terminal ?? null,
      title: b.title,
      body: b.body,
      options: Array.isArray(b.options) ? b.options.filter((o) => typeof o === "string").slice(0, 8) : undefined,
    });
    json(res, 200, item);
  });

  // ---- sessions (live agent sessions) ----
  on("GET", "/api/sessions", async (_req, res) => {
    const tasks = new Map(state.db.listTasks().map((t) => [t.id, t]));
    let sessions: Awaited<ReturnType<WorkerBackend["list"]>> = [];
    try {
      sessions = await state.backend.list();
    } catch {
      /* backend unreachable: report from the db alone */
    }
    const out = sessions.map((s) => {
      const taskId = s.task_id ?? state.db.getTerminal(s.address)?.task_id ?? null;
      const task = taskId ? tasks.get(taskId) ?? null : null;
      return {
        address: s.address,
        name: s.name,
        agent: s.harness ?? s.name,
        task_id: taskId,
        task_title: task ? taskLabel(task) : null,
        status: s.status,
        state: s.state,
        turn: s.turn,
        cwd: s.cwd,
        created_ms: s.created_ms,
        updated_ms: Date.now(),
        exit_code: s.exit_code,
      };
    });
    json(res, 200, out);
  });

  on("POST", "/api/terminals/:address/open", async (_req, res, { params }) => {
    const url = state.backend.inspectUrl?.(params.address) ?? null;
    if (url) {
      state.db.recordMetric("session.opened", params.address, { url });
      json(res, 200, { ok: true, opened: false, url });
      return;
    }
    json(res, 200, { ok: true, opened: false });
  });

  // ---- worker harnesses (dispatch target picker) ----
  on("GET", "/api/harnesses", async (_req, res) => {
    try {
      const harnesses = state.backend.harnesses
        ? await state.backend.harnesses()
        : Object.keys(state.cfg.agents).map((harness) => ({ harness, agents: [] }));
      json(res, 200, { harnesses });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  // ---- pull requests (where the human is awaited) ----
  on("GET", "/api/pulls", (_req, res) => json(res, 200, cachedPulls()));

  on("POST", "/api/pulls/refresh", async (_req, res) => {
    await refreshPulls(state.hub);
    json(res, 200, cachedPulls());
  });

  // ---- repos ----
  on("GET", "/api/repos", (_req, res) => json(res, 200, state.db.listRepos()));

  on("POST", "/api/repos", (req, res, { body }) => {
    const b = body as { path?: string; name?: string; jira_prefix?: string };
    if (!b?.path) return json(res, 400, { error: "path required" });
    try {
      const toplevel = gitToplevel(b.path);
      const repo = addRepo(state.db, toplevel, {
        name: b.name,
        jiraPrefix: b.jira_prefix ?? null,
        source: "manual",
      });
      if (b.jira_prefix && repo.jira_prefix !== b.jira_prefix) {
        state.db.updateRepo(repo.id, { jira_prefix: b.jira_prefix });
        repo.jira_prefix = b.jira_prefix;
      }
      json(res, 200, repo);
    } catch {
      json(res, 400, { error: `not a git repository: ${b.path}` });
    }
  });

  on("PATCH", "/api/repos/:id", (req, res, { body, params }) => {
    const repo = state.db.getRepo(params.id);
    if (!repo) return json(res, 404, { error: "repo not found" });
    const patch = body as Partial<{ name: string; jira_prefix: string | null }>;
    state.db.updateRepo(repo.id, patch);
    json(res, 200, state.db.getRepo(repo.id));
  });

  on("DELETE", "/api/repos/:id", (_req, res, { params }) => {
    state.db.deleteRepo(params.id);
    json(res, 200, { ok: true });
  });

  on("POST", "/api/repos/scan", (_req, res) => {
    const added = scanWorkspaceRepos(state.db, state.cfg.workspaceRoots);
    json(res, 200, { added, total: state.db.listRepos().length, roots: state.cfg.workspaceRoots });
  });

  // ---- jira ----
  on("GET", "/api/jira/search", async (_req, res, { url }) => {
    const q = url.searchParams.get("q") ?? state.cfg.jira.jql;
    if (!q) return json(res, 400, { error: "q required (text or JQL)" });
    try {
      const issues = await state.jira.search(q);
      json(
        res,
        200,
        issues.map((i) => jiraImportCandidate(state, i)),
      );
    } catch (err) {
      console.error("corral: jira search failed:", String(err));
      json(res, 502, { error: String(err) });
    }
  });

  on("POST", "/api/jira/import", async (req, res, { body }) => {
    // items carry the fingerprint the user reviewed; bare keys skip that check.
    const b = body as { items?: { key: string; fingerprint?: string }[]; keys?: string[] };
    const items = b?.items ?? (b?.keys ?? []).map((key) => ({ key, fingerprint: undefined }));
    if (!items.length) return json(res, 400, { error: "items or keys required" });
    const out: { created: Task[]; changed: ReturnType<typeof jiraImportCandidate>[]; skipped: string[]; failed: string[] } =
      { created: [], changed: [], skipped: [], failed: [] };
    for (const { key, fingerprint } of items) {
      if (state.db.getTaskByJiraKey(key)) {
        out.skipped.push(key); // dedupe by issue key
        continue;
      }
      try {
        const f = jiraImportCandidate(state, await state.jira.getIssue(key));
        if (fingerprint !== undefined && fingerprint !== f.fingerprint) {
          out.changed.push(f); // ticket or repo mapping changed since review
          continue;
        }
        const now = Date.now();
        const task: Task = {
          id: randomUUID(),
          title: f.title,
          prompt: f.prompt,
          repo_path: f.repo_path ?? "",
          target: "",
          target_state: "suggested",
          base_branch: null,
          branch: null,
          worktree_path: null,
          assignee: null,
          jira_key: f.jira_key,
          jira_url: f.jira_url,
          jira_parent_key: f.jira_parent_key,
          pr_url: null,
          pr_meta: null,
          status: "open",
          terminal_address: null,
          exit_code: null,
          created_ms: now,
          updated_ms: now,
        };
        state.db.insertTask(task);
        state.db.recordMetric("jira.imported", task.id, { key });
        state.hub.broadcast("task.updated", task);
        out.created.push(task);
      } catch (err) {
        console.error(`corral: jira import ${key} failed`, err);
        out.failed.push(key);
      }
    }
    json(res, 200, out);
  });

  on("POST", "/api/jira/tasks/:id/done", async (req, res, { body, params }) => {
    const task = state.db.getTask(params.id);
    if (!task?.jira_key) return json(res, 404, { error: "task has no jira key" });
    try {
      const used = await state.jira.markDone(task.jira_key, (body as { transition_id?: string })?.transition_id);
      state.db.recordMetric("jira.marked_done", task.id, { key: task.jira_key, transition: used.id });
      json(res, 200, { ok: true, transition: used });
    } catch (err) {
      json(res, 502, { error: String(err) });
    }
  });

  on("POST", "/api/jira/tasks/:id/comment", async (req, res, { body, params }) => {
    const task = state.db.getTask(params.id);
    if (!task?.jira_key) return json(res, 404, { error: "task has no jira key" });
    const text = (body as { text?: string })?.text ?? "";
    if (!text.trim()) return json(res, 400, { error: "text required" });
    try {
      await state.jira.addComment(task.jira_key, text);
      state.db.recordMetric("jira.commented", task.id, { key: task.jira_key });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 502, { error: String(err) });
    }
  });

  // ---- ideas ----
  on("GET", "/api/ideas", (_req, res, { url }) => {
    json(res, 200, state.db.listIdeas(url.searchParams.get("status") ?? undefined));
  });

  on("POST", "/api/ideas", (req, res, { body }) => {
    const b = body as { text?: string; tag?: string; origin?: string };
    if (!b?.text?.trim()) return json(res, 400, { error: "text required" });
    const idea: Idea = {
      id: randomUUID(),
      text: b.text.trim(),
      tag: b.tag === "product" ? "product" : "workflow",
      origin: b.origin === "agent" ? "agent" : "user",
      status: "new",
      created_ms: Date.now(),
    };
    state.db.insertIdea(idea);
    state.db.recordMetric("idea.created", idea.id, { origin: idea.origin, tag: idea.tag });
    state.hub.broadcast("idea.created", idea);
    json(res, 200, idea);
  });

  on("PATCH", "/api/ideas/:id", (req, res, { body, params }) => {
    const patch = body as Partial<Idea>;
    delete patch.id;
    state.db.updateIdea(params.id, patch);
    json(res, 200, { ok: true });
  });

  // ---- metrics / terminals / config ----
  on("GET", "/api/metrics/summary", (_req, res) => {
    json(res, 200, { by_name: state.db.metricSummary(), recent: state.db.recentMetrics(50) });
  });

  on("GET", "/api/terminals", (_req, res) => json(res, 200, state.db.listTerminals()));

  // ---- usage (Claude Code + Codex local logs) ----
  on("GET", "/api/usage", async (_req, res, { url }) => {
    const raw = url.searchParams.get("range") ?? "7d";
    if (!USAGE_RANGES.includes(raw as UsageRange)) return json(res, 400, { error: `range must be one of ${USAGE_RANGES.join(", ")}` });
    const scanner = (state.usage ??= new UsageScanner(defaultSources()));
    // First scan of ~1GB of logs takes a while: answer "scanning" instead of hanging.
    const pass = scanner.refresh(url.searchParams.get("refresh") === "1");
    if (scanner.ready) await pass;
    json(
      res,
      200,
      buildReport({
        records: scanner.records(),
        tasks: state.db.listTasks(),
        prices: { ...DEFAULT_PRICES, ...(state.cfg.usage?.prices ?? {}) },
        range: raw as UsageRange,
        quota: [claudeQuota(scanner.sources.claudeQuotaDir), codexQuota(scanner.codexRateLimits())],
        scanning: !scanner.ready,
      }),
    );
  });

  on("GET", "/api/config", (_req, res) => {
    const cfg = state.cfg;
    json(res, 200, {
      port: cfg.port,
      host: cfg.host,
      agents: Object.keys(cfg.agents),
      assistant: cfg.assistant[0],
      backend: state.backend.name,
      omnigentUrl: cfg.omnigent.baseUrl,
      jiraConfigured: state.jira.configured,
      jiraJql: cfg.jira.jql,
      token: cfg.token.slice(0, 4) + "…", // masked
    });
  });

  on("PUT", "/api/config", (req, res, { body }) => {
    const b = body as { jira?: Record<string, string>; assistant?: string[]; agents?: Record<string, string[]> };
    if (b.jira) Object.assign(state.cfg.jira, b.jira);
    if (b.assistant) state.cfg.assistant = b.assistant;
    if (b.agents) Object.assign(state.cfg.agents, b.agents);
    try {
      const path = join(state.cfg.configDir, "config.json");
      readFileSync(path); // exists?
      const current = JSON.parse(readFileSync(path, "utf8"));
      const merged = { ...current, ...b, jira: { ...current.jira, ...b.jira } };
      writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
    } catch {
      /* config file may not exist in tests */
    }
    json(res, 200, { ok: true });
  });

  // ---- SSE ----
  on("GET", "/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    state.hub.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      state.hub.clients.delete(res);
    });
  });

  // ---- static (web/dist) ----
  const distDir = join(process.cwd(), "web", "dist");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Auth: API requires the token (health + SSE handled below).
    if (path.startsWith("/api/") && path !== "/api/health") {
      const token = tokenOf(req, url);
      if (!state.cfg.token || token !== state.cfg.token) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
    }

    // Route matching
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = path.match(route.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body: unknown;
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        try {
          body = await readBody(req);
        } catch (err) {
          json(res, 400, { error: String(err) });
          return;
        }
      }
      try {
        await route.handler(req, res, { body, params, url });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // Static files
    if (req.method === "GET" || req.method === "HEAD") {
      if (path === "/" && url.searchParams.get("token")) {
        // Bootstrap: ?token=... sets the cookie and cleans the URL.
        res.writeHead(302, {
          "Set-Cookie": `corral_token=${url.searchParams.get("token")}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
          Location: "/",
        });
        res.end();
        return;
      }
      let file = normalize(join(distDir, path));
      if (!file.startsWith(distDir)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      if (!existsSync(file) || statSync(file).isDirectory()) {
        file = join(distDir, "index.html"); // SPA fallback
      }
      if (existsSync(file)) {
        const ext = extname(file);
        const types: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".json": "application/json",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };
        res.writeHead(200, { "Content-Type": types[ext] ?? "application/octet-stream" });
        if (req.method === "HEAD") res.end();
        else res.end(readFileSync(file));
        return;
      }
    }

    json(res, 404, { error: "not found" });
  });

  return server;
}
