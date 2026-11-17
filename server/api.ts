import { isContext, parseFavorites } from "./favorites.ts";
import { parseReviewers, type Reviewer } from "./reviewers.ts";
import { errors } from "./errors.ts";
// HTTP API + static hosting. Token auth middleware (token-ready for LAN/team),
// SSE hub for live inbox updates.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { ModelAvailability, WorkerBackend, WorkerQuestion } from "./worker.ts";
import type { CaptureEngine, Hub } from "./capture.ts";
import type { JiraClient, JiraIssue } from "./jira.ts";
import { syncEpic } from "./epic.ts";
import { createEpicRequestTask, EpicRequestError, saveEpicRequestSettings, type EpicRequestSettings } from "./epic-request.ts";
import { orchestrationPrompt } from "./epic-orchestration.ts";
import { archiveEpicLaunchItems, epicSummary, epicViews, stackEpicTaskOnPrerequisite } from "./epic-graph.ts";
import { applyAmendment, impactedTaskIds, proposeAmendments, rejectAmendment, reviseDesign } from "./epic-design.ts";
import { BlockConflict } from "./jira-blocks.ts";
import { summarizeText, llmComplete } from "./llm.ts";
import { AnalysisAgent } from "./analysis-agent.ts";
import { ImprovementAnalysis } from "./improvement.ts";
import { SkillsAnalysis } from "./skills-analysis.ts";
import { skillsEvidenceSource } from "./skills-evidence.ts";
import { isInterval } from "./analysis-schedule.ts";
import { DATA_NOT_INSTRUCTIONS, dispatchTask } from "./dispatch.ts";
import { dailySummaryPrompt } from "./daily-summary.ts";
import { checkAttachments, MAX_TASK_BODY_BYTES } from "./attachments.ts";
import { logTaskEvent, oneLine, promptData } from "./task-events.ts";
import { addRepo, gitToplevel, importFingerprint, importPreview, jiraKeyPrefix, scanWorkspaceRepos } from "./repos.ts";
import { startSyncAllPrs, syncTaskPr, type PrDelivery } from "./pr.ts";
import { cachedPulls, platformRateLimits, refreshPulls } from "./pulls.ts";
import type { Item, Repo, Task } from "./types.ts";
import { PR_URL_RE, taskLabel } from "./types.ts";
import { PlanError, approvePlan, isDirectory, validateSubtasks } from "./multi-repo.ts";
import { DEFAULT_PRICES, USAGE_RANGES, UsageScanner, buildReport, claudeQuota, codexQuota, defaultSources, GoQuotaCache, type UsageRange } from "./usage.ts";
import { SHIPPED_CATALOG, mergeCatalog, parseCatalog } from "./model-catalog.ts";
import { PrAdditionsCache } from "./usage-pr.ts";
import { withDeadline } from "./deadline.ts";
import { cacheControlFor, etagFor, isFresh } from "./static-cache.ts";
import { SessionFacts } from "./session-facts.ts";
import type { SessionFact } from "./session-facts.ts";

/** The skills prompt carries more evidence than a summary: allow a longer assistant call. */
export const SKILLS_ANALYSIS_TIMEOUT_MS = 300_000;

function dailyInterval(startText: string | null, endText: string | null): { start: number; end: number } | null {
  const start = Number(startText), end = Number(endText);
  if (!startText || !endText || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end - start > 90_000_000) return null;
  return { start, end };
}

export interface AppState {
  db: Db;
  cfg: Config;
  backend: WorkerBackend;
  capture: CaptureEngine;
  jira: JiraClient;
  hub: Hub & { clients: Set<ServerResponse> };
  /** Agent usage scanner (Claude/Codex logs); created on first use when absent. */
  improvement?: ImprovementAnalysis;
  /** Skills analysis (installed skills vs. session use); created on first use when absent. */
  skills?: SkillsAnalysis;
  engineeringSkills?: ImprovementAnalysis;
  usage?: UsageScanner;
  /** Cached OpenCode Go quota snapshot (external HTTPS call, polled by the UI). */
  goQuota?: GoQuotaCache;
  /** Model/reasoning per task session: finished sessions are read once. */
  sessionFacts?: SessionFacts;
  prAdditions?: PrAdditionsCache;
}

/** A Jira issue as the import would create it, plus the fingerprint of those fields. */
function jiraImportCandidate(state: AppState, issue: JiraIssue) {
  const f = state.jira.issueToTaskFields(issue);
  const preview = importPreview(state.db, f.jira_key);
  return { ...f, ...preview, fingerprint: importFingerprint({ ...f, repo_path: preview.repo_path }) };
}

/** Model/reasoning of the tasks' sessions. The backend's `finished` sessions
 *  are read once and kept, everything else through one shared pass per burst of
 *  requests (see session-facts.ts) — the enricher is lazily created so a state
 *  built without a worker backend keeps answering. */
async function taskSessionFacts(state: AppState, tasks: Task[]): Promise<Map<string, SessionFact>> {
  if (!tasks.some((task) => task.terminal_address) || typeof state.backend?.get !== "function") return new Map();
  try {
    return await (state.sessionFacts ??= new SessionFacts(state.backend)).forTasks(tasks);
  } catch {
    return new Map();
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: { body: unknown; params: Record<string, string>; url: URL }) => void | Promise<void>;

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;

function readBody(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
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
  persistPattern?: string;
  questions?: WorkerQuestion[];
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

export function permissionVerdict(e: ItemElicitation, choice: string): { action: "accept" | "decline"; meta?: Record<string, unknown> } | null {
  if (e.kind !== "permission") return null;
  if (choice === "approve") return { action: "accept" };
  if (choice === "reject") return { action: "decline" };
  if (e.persistPattern && (choice === "session" || choice === "always")) {
    return { action: "accept", meta: { persist: choice } };
  }
  return null;
}

/** Reads a page load depends on (sessions, tasks, harnesses) get a bounded
 *  wait: an unreachable worker backend must not hang the request. */
const BACKEND_LIST_MS = 4000;
const BACKEND_HARNESSES_MS = 6000;

export function createHttpServer(state: AppState): ReturnType<typeof createServer> {
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; bodyLimit: number }[] = [];

  /** `bodyLimit` raises the request size cap for the few routes that carry files. */
  const on = (method: string, path: string, handler: Handler, bodyLimit = DEFAULT_BODY_LIMIT) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/:([A-Za-z_]+)/g, (_m, k: string) => {
          keys.push(k);
          return "([^/]+)";
        }) +
        "$",
    );
    routes.push({ method, pattern, keys, handler, bodyLimit });
  };

  const analysisAgent = new AnalysisAgent(state.db, state.hub, state.cfg, state.backend);
  on("GET", "/api/analysis-repo", (_req, res) => json(res, 200, { repo: analysisAgent.repo() }));
  on("PUT", "/api/analysis-repo", (_req, res, { body }) => {
    const repo = (body as { repo?: unknown } | null)?.repo;
    if (typeof repo !== "string") return json(res, 400, { error: "Repository path required" });
    try { analysisAgent.setRepo(repo.trim()); json(res, 200, { repo: analysisAgent.repo() }); }
    catch { json(res, 400, { error: "Repository must be an existing git repository" }); }
  });

  const improvement = state.improvement ??= new ImprovementAnalysis(state.db, state.hub, (prompt) => llmComplete(state.cfg, prompt), {
    agent: analysisAgent,
    usage: async () => {
      const scanner = (state.usage ??= new UsageScanner(defaultSources()));
      await withDeadline(scanner.refresh(), 15_000, undefined);
      return {
        records: scanner.records(),
        prices: { ...DEFAULT_PRICES, ...(state.cfg.usage?.prices ?? {}) },
        scanning: !scanner.ready,
      };
    },
  });
  on("GET", "/api/improvement", (_req, res) => json(res, 200, improvement.status()));
  on("PUT", "/api/improvement", (_req, res, { body }) => {
    const days = (body as { intervalDays?: unknown } | null)?.intervalDays;
    if (!isInterval(days)) return json(res, 400, { error: "Invalid interval" });
    improvement.setIntervalDays(days);
    json(res, 200, improvement.status());
  });
  on("POST", "/api/improvement/run", async (_req, res) => {
    try { json(res, 200, await improvement.run()); }
    catch (err) { json(res, 500, { error: err instanceof Error ? err.message : String(err) }); }
  });

  const engineeringSkills = state.engineeringSkills ??= new ImprovementAnalysis(state.db, state.hub, (prompt) => llmComplete(state.cfg, prompt), { agent: analysisAgent, mode: "engineering-skills" });
  on("GET", "/api/engineering-skills", (_req, res) => json(res, 200, engineeringSkills.status()));
  on("PUT", "/api/engineering-skills", (_req, res, { body }) => {
    const days = (body as { intervalDays?: unknown } | null)?.intervalDays;
    if (!isInterval(days)) return json(res, 400, { error: "Invalid interval" });
    engineeringSkills.setIntervalDays(days);
    json(res, 200, engineeringSkills.status());
  });
  on("POST", "/api/engineering-skills/run", async (_req, res) => {
    try { json(res, 200, await engineeringSkills.run()); }
    catch (err) { json(res, 500, { error: err instanceof Error ? err.message : String(err) }); }
  });

  const skills = state.skills ??= new SkillsAnalysis(state.db, state.hub, (prompt) => llmComplete(state.cfg, prompt, SKILLS_ANALYSIS_TIMEOUT_MS), { evidence: skillsEvidenceSource(state.db), agent: analysisAgent });
  on("GET", "/api/skills-analysis", (_req, res) => json(res, 200, skills.status()));
  on("PUT", "/api/skills-analysis", (_req, res, { body }) => {
    const days = (body as { intervalDays?: unknown } | null)?.intervalDays;
    if (!isInterval(days)) return json(res, 400, { error: "Invalid interval" });
    skills.setIntervalDays(days);
    json(res, 200, skills.status());
  });
  on("POST", "/api/skills-analysis/run", async (_req, res) => {
    try { json(res, 200, await skills.run()); }
    catch (err) { json(res, 500, { error: err instanceof Error ? err.message : String(err) }); }
  });

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
    const { text = "", permission, content } = (body ?? {}) as { text?: string; permission?: string; content?: unknown };
    if (typeof text !== "string" || (!text.trim() && !permission && content === undefined)) return json(res, 400, { error: "text or answers required" });
    if ((permission || content !== undefined || item.elicitation) && item.status !== "open") return json(res, 409, { error: "item is not open" });
    const address = item.source_ref ?? (item.task_id ? state.db.getTask(item.task_id)?.terminal_address : null);
    if (!address) return json(res, 409, { error: "no terminal linked to this item" });
    const elicitation = parseElicitation(item.elicitation);
    if (content !== undefined) {
      if (permission || text.trim() || !elicitation?.questions?.length || !content || typeof content !== "object" || Array.isArray(content)) {
        return json(res, 400, { error: "invalid question answers" });
      }
      const answers = content as Record<string, unknown>;
      if (Object.keys(answers).length !== elicitation.questions.length || elicitation.questions.some((q) => {
        const answer = answers[q.id];
        return q.multiple
          ? !Array.isArray(answer) || !answer.length || answer.some((v) => typeof v !== "string" || !v.trim())
          : typeof answer !== "string" || !answer.trim();
      })) return json(res, 400, { error: "answer every question with the expected selection type" });
      await state.backend.resolveElicitation(address, elicitation.id, "accept", answers);
    } else if (elicitation?.questions?.length && !elicitation.field) {
      return json(res, 400, { error: "structured answers required for this question" });
    } else if (permission) {
      const verdict = elicitation && permissionVerdict(elicitation, permission);
      if (!verdict) return json(res, 400, { error: "invalid permission choice" });
      await state.backend.resolveElicitation(address, elicitation!.id, verdict.action, undefined, verdict.meta);
    } else if (elicitation) {
      // A captured permission/question is answered on the elicitation itself;
      // a plain message would leave it pending in the backend.
      const verdict = elicitationVerdict(elicitation, text);
      await state.backend.resolveElicitation(address, elicitation.id, verdict.action, verdict.content);
      if (verdict.forward) await state.backend.send(address, text);
    } else {
      await state.backend.send(address, text);
    }
    // A reply is a prompt to the agent: the task's history shows what the
    // human answered and which question it closed.
    if (item.task_id) {
      const answered = content !== undefined ? "answers to a question batch" : permission ? `permission: ${permission}` : oneLine(text, 110);
      logTaskEvent(state.db, item.task_id, "prompt", `Replied: ${answered}`, promptData(
        content !== undefined ? JSON.stringify(content) : permission || text.trim(),
        { item_id: item.id, item_kind: item.kind, session: address },
      ));
    }
    state.db.updateItem(item.id, { status: "resolved", resolved_ms: Date.now(), body: `${item.body}\n\n**Reply:** ${content !== undefined ? JSON.stringify(content) : permission || text.trim()}` });
    state.db.reward("inbox", item.id);
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
    const item = state.db.getItem(params.id);
    if (!item) return json(res, 404, { error: "item not found" });
    state.db.updateItem(params.id, { status: "resolved", resolved_ms: Date.now() });
    state.db.reward("inbox", item.id);
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

  on("GET", "/api/progression", (_req, res) => json(res, 200, state.db.progression()));

  on("GET", "/api/daily", (_req, res, { url }) => {
    const interval = dailyInterval(url.searchParams.get("start"), url.searchParams.get("end"));
    if (!interval) return json(res, 400, { error: "invalid day interval" });
    const events = state.db.listDailyActivity(interval.start, interval.end);
    json(res, 200, events.map((event) => ({
      ...event,
      session_url: event.terminal_address && state.backend.inspectUrl
        ? state.backend.inspectUrl(event.terminal_address)
        : null,
    })));
  });

  on("POST", "/api/daily/summarize", async (req, res, { body }) => {
    const b = (body ?? {}) as { start?: unknown; end?: unknown; date?: unknown; favorite?: unknown };
    const interval = dailyInterval(typeof b.start === "number" ? String(b.start) : null, typeof b.end === "number" ? String(b.end) : null);
    if (!interval) return json(res, 400, { error: "invalid day interval" });
    if (b.date !== undefined && (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date))) return json(res, 400, { error: "invalid day" });
    const favoriteName = typeof b.favorite === "string" ? b.favorite.trim() : "";
    const favorite = (state.cfg.favorites ?? []).find((f) => f.name === favoriteName && (f.context ?? "professional") === "professional");
    if (!favorite) return json(res, 400, { error: "choose a configured professional favorite" });
    const events = state.db.listDailyActivity(interval.start, interval.end);
    if (events.length === 0) return json(res, 409, { error: "no professional activity recorded for this day" });
    const repo = events.find((event) => event.repo_path?.trim())?.repo_path ?? "";
    if (!repo) return json(res, 400, { error: "the day's tasks have no repository" });
    const date = typeof b.date === "string" ? b.date : new Date(interval.start).toISOString().slice(0, 10);
    try {
      const task = await analysisAgent.start(`Daily standup summary — ${date}`, dailySummaryPrompt(events, date), {
        repo,
        target: favorite.harness,
        agent: favorite.agent || null,
        model: favorite.model || null,
        reasoning: favorite.reasoning || null,
        source: "daily",
      });
      json(res, 200, { task });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  // ---- tasks ----
  on("GET", "/api/tasks", async (_req, res, { url }) => {
    const status = url.searchParams.get("status") ?? undefined;
    const tasks = state.db.listTasks(status as never);
    const facts = await taskSessionFacts(state, tasks);
    const attachments = state.db.attachmentCounts();
    json(res, 200, tasks.map((task) => {
      const fact = task.terminal_address ? facts.get(task.terminal_address) : undefined;
      return {
        ...task,
        session_model: fact?.model ?? null,
        session_reasoning: fact?.reasoning ?? null,
        attachment_count: attachments.get(task.id) ?? 0,
      };
    }));
  });

  on("POST", "/api/tasks", (req, res, { body }) => {
    const b = body as Partial<Task> & { attachments?: unknown };
    const kind = b?.kind ?? "code";
    if (kind !== "code" && kind !== "review" && kind !== "spec") return json(res, 400, { error: "kind must be code, review or spec" });
    if (kind === "spec") {
      if (!b?.prompt?.trim()) return json(res, 400, { error: "spec tasks need a prompt" });
      if (!b.repo_path?.trim() || !isDirectory(b.repo_path)) return json(res, 400, { error: "spec tasks need an existing folder in repo_path" });
    }
    const prUrl = b?.pr_url?.trim() || null;
    if (kind === "review" && (!prUrl || !PR_URL_RE.test(prUrl))) {
      return json(res, 400, { error: "review tasks need a GitHub PR or GitLab MR URL" });
    }
    if (kind !== "review" && !b?.title?.trim() && !b?.prompt?.trim()) return json(res, 400, { error: "title or prompt required" });
    // Checked before anything is stored: a bad file must not leave a task behind.
    const attached = checkAttachments(b?.attachments);
    if (!attached.ok) return json(res, attached.status, { error: attached.error });
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      // Empty title = adopt omnigent's session title once dispatched.
      title: b.title?.trim() || (kind === "review" ? `Review ${prUrl}` : ""),
      prompt: b.prompt ?? "",
      kind,
      repo_path: b.repo_path ?? "",
      target: b.target ?? "",
      target_state: "suggested",
      model: b.model?.trim() || null,
      reasoning: b.reasoning?.trim() || null,
      base_branch: b.base_branch ?? null,
      branch: null,
      worktree_path: null,
      assignee: b.assignee ?? null,
      jira_key: b.jira_key ?? null,
      jira_url: b.jira_url ?? null,
      jira_parent_key: b.jira_parent_key ?? null,
      pr_url: kind === "review" ? prUrl : null,
      pr_meta: null,
      status: "open",
      terminal_address: null,
      exit_code: null,
      created_ms: now,
      updated_ms: now,
    };
    state.db.insertTaskWithAttachments(task, attached.files);
    state.db.reward("task", task.id);
    state.db.recordMetric("task.created", task.id, { source: b.jira_key ? "jira" : "manual" });
    logTaskEvent(state.db, task.id, "created", kind === "review" ? "Review task created" : kind === "spec" ? "Multi-repo spec task created" : "Task created", {
      source: b.jira_key ? "jira" : "manual",
      kind,
      repo: task.repo_path || null,
      target: task.target || null,
      pr: task.pr_url,
      attachments: attached.files.length || undefined,
    });
    state.hub.broadcast("task.updated", task);
    json(res, 200, task);
  }, MAX_TASK_BODY_BYTES);

  on("GET", "/api/tasks/:id/attachments", (_req, res, { params }) => {
    if (!state.db.getTask(params.id)) return json(res, 404, { error: "task not found" });
    json(res, 200, state.db.listTaskAttachments(params.id));
  });

  on("PATCH", "/api/tasks/:id", (req, res, { body, params }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    const patch = body as Partial<Task>;
    delete patch.id;
    delete patch.kind; // fixed at creation: dispatch and the PR loop depend on it
    state.db.updateTask(task.id, patch);
    state.hub.broadcast("task.updated", state.db.getTask(task.id));
    json(res, 200, state.db.getTask(task.id));
  });

  on("GET", "/api/tasks/:id/events", (_req, res, { params, url }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    const requested = Number(url.searchParams.get("limit") ?? 0);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 2000) : 500;
    json(res, 200, state.db.listTaskEvents(task.id, limit));
  });

  on("POST", "/api/tasks/:id/artifact", async (_req, res, { params }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    if (task.target !== "claude" || task.status !== "dispatched" || !task.terminal_address) {
      return json(res, 409, { error: "task has no active Claude session" });
    }
    const prompt = "Create a Claude artifact that explains this task and its results to colleagues. Publish it privately and report the artifact URL in the Corral inbox. Do not share it publicly.";
    await state.backend.send(task.terminal_address, prompt);
    logTaskEvent(state.db, task.id, "prompt", "Requested a Claude artifact", promptData(prompt, { session: task.terminal_address }));
    json(res, 200, { ok: true });
  });

  on("POST", "/api/tasks/:id/archive-session", async (_req, res, { params }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    if (task.status !== "dispatched" || !task.terminal_address) return json(res, 400, { error: "task has no active session" });
    if (!state.backend.archive) return json(res, 501, { error: "this backend cannot archive sessions" });
    try {
      await state.backend.archive(task.terminal_address);
      state.db.updateTask(task.id, { status: "archived" });
      const updated = state.db.getTask(task.id);
      state.hub.broadcast("task.updated", updated);
      json(res, 200, updated);
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  on("POST", "/api/tasks/:id/dispatch", async (req, res, { body, params }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    if (task.status === "dispatched") {
      // A task marked dispatched with no live session behind it (e.g. the
      // agent already finished, or the session vanished) is effectively still
      // open: reopen it instead of refusing to dispatch.
      let active = false;
      if (task.terminal_address && typeof state.backend.get === "function") {
        try {
          const session = await state.backend.get(task.terminal_address);
          active = !!session && session.state !== "finished"
            && session.status !== "done" && session.status !== "error";
        } catch {
          active = false;
        }
      } else if (task.terminal_address) {
        active = true;
      }
      if (active) return json(res, 409, { error: "task already dispatched" });
      state.db.updateTask(task.id, { status: "open", terminal_address: null });
    }
    const b = (body ?? {}) as {
      target?: string;
      use_worktree?: boolean;
      model?: string | null;
      reasoning?: string | null;
      agent?: string | null;
      review?: string | null;
    };
    const target = b.target ?? task.target;
    if (!target) return json(res, 400, { error: "target required (claude|codex|opencode)" });
    if (task.kind === "review" && target !== "claude") return json(res, 400, { error: "review tasks run on the claude harness only" });
    if (!task.repo_path?.trim()) return json(res, 400, { error: "task has no repo — assign one before dispatching" });
    try {
      const result = await dispatchTask(state.db, state.cfg, state.backend, task, target, {
        useWorktree: b.use_worktree,
        model: b.model === undefined ? task.model : b.model,
        reasoning: b.reasoning === undefined ? task.reasoning : b.reasoning,
        agent: b.agent === undefined ? task.agent ?? null : b.agent,
        review: b.review ?? null,
        jira: state.jira ?? null,
      });
      state.hub.broadcast("task.updated", state.db.getTask(task.id));
      if (task.epic_id) archiveEpicLaunchItems(state.db, state.hub);
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  on("POST", "/api/tasks/:id/approve-plan", (_req, res, { params }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    try {
      const children = approvePlan(state.db, state.hub, task);
      json(res, 200, { children });
    } catch (err) {
      if (err instanceof PlanError) return json(res, 400, { error: err.message });
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

  // Re-check one task's PR/MR now. `force: true` (inbox "force refresh") also
  // re-hands review comments and merge conflicts the loop already pushed, and
  // waits for the hand-off so the caller can report what it did.
  on("POST", "/api/tasks/:id/check-pr", async (req, res, { params, body }) => {
    const task = state.db.getTask(params.id);
    if (!task) return json(res, 404, { error: "task not found" });
    if (task.kind === "review") return json(res, 400, { error: "review tasks have no PR of their own" });
    if (task.kind === "spec") return json(res, 400, { error: "spec tasks have no PR of their own" });
    if (!task.branch) return json(res, 400, { error: "task has no branch (dispatch it first)" });
    const force = (body as { force?: unknown } | undefined)?.force === true;
    const report: { delivered: PrDelivery | null } = { delivered: null };
    try {
      const pr = await syncTaskPr(state.db, state.hub, task, {
        backend: state.backend,
        cfg: state.cfg,
        jira: state.jira ?? null,
        force,
        onDelivered: (delivery) => { report.delivered = delivery; },
      });
      json(res, 200, { pr, task: state.db.getTask(task.id), delivered: report.delivered });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  // Inbox open: re-check PRs so merged ones are archived before the human looks.
  on("POST", "/api/prs/sync", (_req, res) => {
    const pending = startSyncAllPrs(state.db, state.hub, { backend: state.backend, cfg: state.cfg, jira: state.jira ?? null, knownPrsOnly: true });
    if (pending) void pending.catch(() => undefined);
    json(res, 200, { ok: true, ran: pending !== null });
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
      contract?: string;
      subtasks?: unknown;
    };
    if (b.kind === "plan") {
      const planBody = body as { subtasks?: unknown; contract?: string };
      const task = b.task_id ? state.db.getTask(b.task_id) : null;
      if (!task || task.kind !== "spec") return json(res, 400, { error: "a plan report needs the task_id of a spec task" });
      if (!b.title || !planBody.contract?.trim()) return json(res, 400, { error: "title and contract required" });
      try {
        const subtasks = validateSubtasks(task.repo_path, planBody.subtasks);
        const item = await state.capture.createPlan(task.id, b.title, { contract: planBody.contract, subtasks });
        return json(res, 200, item);
      } catch (err) {
        if (err instanceof PlanError) return json(res, 400, { error: err.message });
        throw err;
      }
    }
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
      sessions = await withDeadline(state.backend.list(), BACKEND_LIST_MS, []);
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
        ? await withDeadline(state.backend.harnesses(), BACKEND_HARNESSES_MS, null)
        : Object.keys(state.cfg.agents).map((harness) => ({ harness, agents: [] }));
      if (!harnesses) return json(res, 504, { error: "the worker backend did not answer — try again in a moment" });
      const agents = state.backend.registryAgents
        ? await withDeadline(state.backend.registryAgents(), BACKEND_HARNESSES_MS, harnesses.flatMap((h) => h.agents))
        : harnesses.flatMap((h) => h.agents);
      json(res, 200, { harnesses, agents });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  on("GET", "/api/errors", (_req, res) => json(res, 200, errors.list()));

  // ---- model facts (quality, cost, quota, retention — data, never policy) ----
  const modelCatalog = () => mergeCatalog(SHIPPED_CATALOG, state.cfg.models);
  on("GET", "/api/models", (_req, res) => json(res, 200, { models: modelCatalog() }));
  // Local model servers (GPU box): configured providers are probed per request,
  // behind a 2 s probe + 30 s cache. Anything not answering in time is unknown.
  on("GET", "/api/models/availability", async (_req, res) => {
    const providers = Object.keys(state.cfg.omnigent.localProviders ?? {});
    const entries = await Promise.all(providers.map(async (provider): Promise<[string, ModelAvailability]> => {
      const unknown: ModelAvailability = { status: "unknown", models: [] };
      const result = state.backend.providerModels
        ? await withDeadline(state.backend.providerModels(provider).catch(() => unknown), 3000, unknown)
        : unknown;
      return [provider, result];
    }));
    json(res, 200, { providers: Object.fromEntries(entries) });
  });

  // ---- pull requests (where the human is awaited, plus colleagues' PRs) ----
  on("GET", "/api/pulls", (_req, res) => json(res, 200, cachedPulls()));

  on("POST", "/api/pulls/refresh", async (_req, res) => {
    await refreshPulls(state.hub, { repoPaths: state.db.listRepos().map((repo) => repo.path), db: state.db });
    json(res, 200, cachedPulls());
  });

  // Remaining GitHub/GitLab API quota, shown next to the agent quotas on Usage.
  on("GET", "/api/rate-limits", async (_req, res, { url }) => {
    json(res, 200, { limits: await platformRateLimits(url.searchParams.get("refresh") === "1"), fetched_ms: Date.now() });
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
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.context !== undefined && b.context !== null && !isContext(b.context)) return json(res, 400, { error: "context must be professional, personal or null" });
    const patch: Partial<Repo> = {};
    if (typeof b.name === "string") patch.name = b.name;
    if (typeof b.jira_prefix === "string" || b.jira_prefix === null) patch.jira_prefix = b.jira_prefix;
    if (b.context !== undefined) patch.context = b.context as Repo["context"];
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

  // ---- epics ----
  const epicDetail = (id: string) => {
    const epic = state.db.getEpic(id);
    if (!epic) return null;
    const tasks = state.db.listEpicTasks(id), links = state.db.listEpicLinks(id);
    const impacted = impactedTaskIds(state.db, id);
    const views = epicViews(tasks, links, state.db.listItems()).map((v) => ({ ...v, impacted: impacted.has(v.task.id) }));
    return {
      epic, tasks, links, views, summary: epicSummary(views),
      design: state.db.latestDesign(id), design_versions: state.db.listDesigns(id).length,
      amendments: state.db.listAmendments(id, "proposed"),
    };
  };

  on("GET", "/api/epics", (_req, res) => {
    const items = state.db.listItems();
    json(res, 200, state.db.listEpics().map((epic) => ({
      ...epic,
      summary: epicSummary(epicViews(state.db.listEpicTasks(epic.id), state.db.listEpicLinks(epic.id), items)),
    })));
  });

  on("GET", "/api/epics/:id", (_req, res, { params }) => {
    const detail = epicDetail(params.id);
    if (!detail) return json(res, 404, { error: "epic not found" });
    json(res, 200, detail);
  });

  const epicRequestSettings = (body: unknown): EpicRequestSettings => {
    const b = (body ?? {}) as { favorite_name?: unknown; repo_path?: unknown };
    if (b.favorite_name !== undefined && typeof b.favorite_name !== "string") throw new EpicRequestError("favorite_name must be a string");
    if (b.repo_path !== undefined && typeof b.repo_path !== "string") throw new EpicRequestError("repo_path must be a string");
    const out: EpicRequestSettings = {};
    if (b.favorite_name !== undefined) out.favorite_name = b.favorite_name;
    if (b.repo_path !== undefined) out.repo_path = b.repo_path;
    return out;
  };

  const epicRequestFailure = (res: ServerResponse, err: unknown) =>
    json(res, err instanceof EpicRequestError ? 400 : 500, { error: String(err instanceof Error ? err.message : err) });

  // The selectors are saved as soon as they change, so the next request on
  // this epic starts from the same favorite and folder.
  on("PATCH", "/api/epics/:id", (_req, res, { params, body }) => {
    const epic = state.db.getEpic(params.id);
    if (!epic) return json(res, 404, { error: "epic not found" });
    try {
      const input = epicRequestSettings(body);
      const available = (state.cfg.favorites ?? []).filter((f) =>
        (f.context ?? "professional") === (state.db.listRepos().find((r) => r.path === (input.repo_path ?? epic.repo_path))?.context ?? "professional"));
      const storedFavorite = available.some((f) => f.name === (input.favorite_name ?? epic.favorite_name))
        ? input.favorite_name ?? epic.favorite_name ?? ""
        : "";
      saveEpicRequestSettings(state.db, epic, {
        favorite_name: storedFavorite,
        repo_path: input.repo_path ?? epic.repo_path ?? "",
      }, state.cfg.favorites ?? []);
      state.hub.broadcast("epic.updated", state.db.getEpic(epic.id));
      json(res, 200, epicDetail(epic.id));
    } catch (err) { epicRequestFailure(res, err); }
  });

  // One free-form field on the Epic page: every kind of request becomes a
  // tracked task, with the epic's saved dispatch choices. Nothing is launched.
  on("POST", "/api/epics/:id/requests", (_req, res, { params, body }) => {
    const epic = state.db.getEpic(params.id);
    if (!epic) return json(res, 404, { error: "epic not found" });
    const b = (body ?? {}) as { request?: unknown };
    if (typeof b.request !== "string") return json(res, 400, { error: "request required" });
    try {
      const input = epicRequestSettings(body);
      const task = createEpicRequestTask(state.db, epic, {
        request: b.request,
        favorite_name: input.favorite_name ?? epic.favorite_name ?? "",
        repo_path: input.repo_path ?? epic.repo_path ?? "",
      }, state.cfg.favorites ?? [], state.cfg.reviewers ?? []);
      state.hub.broadcast("task.updated", task);
      state.hub.broadcast("epic.updated", state.db.getEpic(epic.id));
      json(res, 200, task);
    } catch (err) { epicRequestFailure(res, err); }
  });

  // A ready epic task starts only when the human clicks on the Epic page.
  // Readiness is rechecked here: a stale page must not launch a blocked task.
  on("POST", "/api/epics/:id/tasks/:taskId/launch", async (_req, res, { params }) => {
    const epic = state.db.getEpic(params.id);
    if (!epic) return json(res, 404, { error: "epic not found" });
    if (epic.error) return json(res, 409, { error: epic.error });
    const view = epicViews(
      state.db.listEpicTasks(epic.id), state.db.listEpicLinks(epic.id), state.db.listItems(),
    ).find((v) => v.task.id === params.taskId);
    if (!view) return json(res, 404, { error: "task not in epic" });
    if (view.state !== "ready") return json(res, 409, { error: `task is ${view.state}, only ready tasks can be launched` });
    const task = view.task;
    if (!task.target) return json(res, 400, { error: "task has no harness — set one on the task before launching" });
    if (!task.repo_path?.trim()) return json(res, 400, { error: "task has no repo — set one on the task before launching" });
    stackEpicTaskOnPrerequisite(state.db, state.hub, view);
    try {
      const result = await dispatchTask(
        state.db, state.cfg, state.backend, state.db.getTask(task.id)!, task.target, { jira: state.jira ?? null },
      );
      archiveEpicLaunchItems(state.db, state.hub);
      state.hub.broadcast("task.updated", state.db.getTask(task.id));
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  on("POST", "/api/epics/:id/orchestrate", async (_req, res, { params, body }) => {
    const detail = epicDetail(params.id);
    if (!detail) return json(res, 404, { error: "epic not found" });
    const request = (body as { request?: unknown } | null)?.request;
    if (typeof request !== "string" || !request.trim() || request.length > 8000) return json(res, 400, { error: "request must be between 1 and 8000 characters" });
    const tasks = detail.views.map((v) => ({ key: v.task.jira_key ?? v.task.id, title: v.task.title, description: v.task.prompt, repo: v.task.repo_path, state: v.state, blockers: v.blockers.filter((b) => !b.satisfied).map((b) => b.key) }));
    try {
      const proposal = await llmComplete(state.cfg, orchestrationPrompt(DATA_NOT_INSTRUCTIONS, request.trim(), detail.epic, detail.design?.body ?? detail.epic.description, tasks), 180_000);
      json(res, 200, { proposal });
    } catch (err) {
      json(res, 502, { error: `Assistant failed: ${String(err)}` });
    }
  });

  // Import by epic key, or resync when it is already known: the same call.
  const runEpicSync = async (res: ServerResponse, key: string) => {
    if (!state.jira?.configured) return json(res, 400, { error: "Jira is not configured" });
    try {
      const result = await syncEpic(state.db, state.jira, key);
      archiveEpicLaunchItems(state.db, state.hub);
      state.hub.broadcast("epic.updated", result.epic);
      json(res, 200, { ...result, ...epicDetail(result.epic.id) });
    } catch (err) {
      console.error("corral: epic sync failed:", String(err));
      json(res, 502, { error: String(err) });
    }
  };

  on("POST", "/api/epics", async (_req, res, { body }) => {
    const key = String((body as { key?: unknown } | null)?.key ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]+-\d+$/.test(key)) return json(res, 400, { error: "key must be a Jira issue key, e.g. OPS-12" });
    await runEpicSync(res, key);
  });

  // Publish a new design version. The human submitting it is the validation:
  // the version goes into the epic's Jira description, then an assistant
  // proposes amendments for the unstarted tasks (inbox items to apply or reject).
  on("POST", "/api/epics/:id/design", async (_req, res, { body, params }) => {
    const epic = state.db.getEpic(params.id);
    if (!epic) return json(res, 404, { error: "epic not found" });
    const b = body as { body?: unknown; reason?: unknown } | null;
    const text = typeof b?.body === "string" ? b.body.trim() : "";
    if (!text) return json(res, 400, { error: "body required" });
    if (!state.jira?.configured) return json(res, 400, { error: "Jira is not configured" });
    const reason = typeof b?.reason === "string" ? b.reason : "";
    try {
      const design = await reviseDesign(state.db, state.jira, epic, { body: text, reason });
      void proposeAmendments(state.db, state.hub, epic, design.version, reason, DATA_NOT_INSTRUCTIONS, (prompt) => llmComplete(state.cfg, prompt, 180_000))
        .catch((err) => console.error("corral: amendment proposals failed:", String(err)));
      state.hub.broadcast("epic.updated", epic);
      json(res, 200, epicDetail(epic.id));
    } catch (err) {
      if (err instanceof BlockConflict) return json(res, 409, { error: err.message, conflict: true });
      console.error("corral: design revision failed:", String(err));
      json(res, 502, { error: String(err) });
    }
  });

  // The UI holds the inbox item, the API the amendment: both address the same one.
  const amendmentOf = (id: string, byItem: boolean) => (byItem ? state.db.getAmendmentByItem(id) : state.db.getAmendment(id));
  for (const [prefix, byItem] of [["/api/amendments/:id", false], ["/api/items/:id/amendment", true]] as const) {
    on("POST", `${prefix}/apply`, async (_req, res, { params }) => {
      const a = amendmentOf(params.id, byItem);
      if (!a) return json(res, 404, { error: "amendment not found" });
      if (a.status !== "proposed") return json(res, 409, { error: `amendment already ${a.status}` });
      if (!state.jira?.configured) return json(res, 400, { error: "Jira is not configured" });
      try {
        await applyAmendment(state.db, state.hub, state.jira, a);
        json(res, 200, byItem ? state.db.getItem(params.id) : state.db.getAmendment(a.id));
      } catch (err) {
        if (err instanceof BlockConflict) return json(res, 409, { error: err.message, conflict: true });
        json(res, 502, { error: String(err) });
      }
    });

    on("POST", `${prefix}/reject`, (_req, res, { params }) => {
      const a = amendmentOf(params.id, byItem);
      if (!a) return json(res, 404, { error: "amendment not found" });
      if (a.status !== "proposed") return json(res, 409, { error: `amendment already ${a.status}` });
      rejectAmendment(state.db, state.hub, a);
      json(res, 200, byItem ? state.db.getItem(params.id) : state.db.getAmendment(a.id));
    });
  }

  on("POST", "/api/epics/:id/sync", async (_req, res, { params }) => {
    const epic = state.db.getEpic(params.id);
    if (!epic) return json(res, 404, { error: "epic not found" });
    await runEpicSync(res, epic.jira_key);
  });

  on("POST", "/api/jira/import", async (req, res, { body }) => {
    // items carry the fingerprint the user reviewed; bare keys skip that check.
    const b = body as { items?: { key: string; fingerprint?: string; repo_path?: string; base_branch?: string | null; target?: string; agent?: string | null; model?: string | null; reasoning?: string | null }[]; keys?: string[] };
    const items: NonNullable<typeof b.items> = b?.items ?? (b?.keys ?? []).map((key) => ({ key }));
    if (!items.length) return json(res, 400, { error: "items or keys required" });
    const out: { created: Task[]; changed: ReturnType<typeof jiraImportCandidate>[]; skipped: string[]; failed: string[] } =
      { created: [], changed: [], skipped: [], failed: [] };
    for (const item of items) {
      const { key, fingerprint } = item;
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
          repo_path: item.repo_path ?? f.repo_path ?? "",
          target: item.target ?? "",
          target_state: "suggested",
          agent: item.agent?.trim() || null,
          model: item.model?.trim() || null,
          reasoning: item.reasoning?.trim() || null,
          base_branch: item.base_branch?.trim() || null,
          branch: null,
          worktree_path: null,
          assignee: null,
          jira_key: f.jira_key,
          jira_url: f.jira_url,
          jira_parent_key: f.jira_parent_key,
          jira_status: f.jira_status,
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
        logTaskEvent(state.db, task.id, "created", `Imported from Jira ${f.jira_key}`, {
          source: "jira",
          key: f.jira_key,
          jira_status: f.jira_status,
          repo: task.repo_path || null,
        });
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
      logTaskEvent(state.db, task.id, "jira", `Marked ${task.jira_key} done (${used.name ?? used.id})`, { key: task.jira_key, transition: used.id });
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
      logTaskEvent(state.db, task.id, "jira", `Commented on ${task.jira_key}`, { key: task.jira_key, chars: text.length });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 502, { error: String(err) });
    }
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
    const tasks = state.db.listTasks();
    const prAdditions = (state.prAdditions ??= new PrAdditionsCache()).get(tasks, url.searchParams.get("refresh") === "1");
    // First scan of ~1GB of logs takes a while: answer "scanning" instead of hanging.
    const pass = scanner.refresh(url.searchParams.get("refresh") === "1");
    if (scanner.ready) await pass;
    json(
      res,
      200,
      { ...buildReport({
        records: scanner.records(),
        tasks,
        prices: { ...DEFAULT_PRICES, ...(state.cfg.usage?.prices ?? {}) },
        range: raw as UsageRange,
        quota: [claudeQuota(scanner.sources.claudeQuotaDir), codexQuota(scanner.codexRateLimits()), await (state.goQuota ??= new GoQuotaCache()).get()],
        scanning: !scanner.ready,
      }), pr_additions: prAdditions },
    );
  });

  on("GET", "/api/config", (_req, res) => {
    const cfg = state.cfg;
    json(res, 200, {
      // Favorites saved before contexts existed read as professional.
      favorites: (cfg.favorites ?? []).map((f) => ({ ...f, context: isContext(f.context) ? f.context : "professional" })),
      reviewers: cfg.reviewers ?? [],
      port: cfg.port,
      host: cfg.host,
      agents: Object.keys(cfg.agents),
      assistant: cfg.assistant[0],
      backend: state.backend.name,
      models: state.cfg.models ?? {},
      omnigentUrl: cfg.omnigent.baseUrl,
      jiraConfigured: state.jira.configured,
      jiraJql: cfg.jira.jql,
      token: cfg.token.slice(0, 4) + "…", // masked
    });
  });

  on("PUT", "/api/config", (req, res, { body }) => {
    const b = body as { jira?: Record<string, string>; assistant?: string[]; agents?: Record<string, string[]>; favorites?: unknown; models?: unknown; reviewers?: unknown };
    if (b.favorites !== undefined) {
      try { b.favorites = parseFavorites(b.favorites); } catch { return json(res, 400, { error: "Invalid favorites" }); }
    }
    if (b.reviewers !== undefined) {
      try { b.reviewers = parseReviewers(b.reviewers); } catch { return json(res, 400, { error: "Invalid reviewers" }); }
    }
    if (b.models !== undefined) {
      try { b.models = parseCatalog(b.models); } catch (err) { return json(res, 400, { error: err instanceof Error ? err.message : String(err) }); }
    }
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
      if (b.favorites !== undefined) return json(res, 500, { error: "Could not save favorites" });
      if (b.reviewers !== undefined) return json(res, 500, { error: "Could not save reviewers" });
      if (b.models !== undefined) return json(res, 500, { error: "Could not save models" });
    }
    if (b.favorites !== undefined) state.cfg.favorites = b.favorites as import("./favorites.ts").Favorite[];
    if (b.reviewers !== undefined) state.cfg.reviewers = b.reviewers as Reviewer[];
    if (b.models !== undefined) state.cfg.models = b.models as import("./model-catalog.ts").ModelCatalog;
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
          body = await readBody(req, route.bodyLimit);
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

    // An unmatched API path is a missing endpoint, never a page: answering it
    // with the SPA shell (200 text/html) makes a stale server look like a
    // broken UI and surfaces as a raw "JSON.parse: unexpected character".
    if (path === "/api" || path.startsWith("/api/")) {
      json(res, 404, { error: `unknown endpoint: ${req.method} ${path}` });
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
        const stat = statSync(file);
        const etag = etagFor(stat.size, stat.mtimeMs);
        const cacheControl = cacheControlFor(path);
        const head = { "Content-Type": types[ext] ?? "application/octet-stream", "Cache-Control": cacheControl, ETag: etag };
        // Revalidation is cheap and keeps a cached shell honest: 304 when the
        // file did not change, a full body when a deploy replaced it.
        if (isFresh(req.headers["if-none-match"], etag)) {
          res.writeHead(304, { "Cache-Control": cacheControl, ETag: etag });
          res.end();
          return;
        }
        res.writeHead(200, head);
        if (req.method === "HEAD") res.end();
        else res.end(readFileSync(file));
        return;
      }
    }

    json(res, 404, { error: "not found" });
  });

  return server;
}
