// Evidence for the skills analysis: which agent skills exist on this machine
// and which of them the human's coding-agent sessions actually invoked.
//
// Usage is counted only from structured invocations, never by searching for a
// skill's name: every Claude Code transcript embeds the full skill listing in
// its request snapshots, and Codex lists skills in its developer messages, so a
// text match would mark every skill as used in every session.
//   - Claude Code: an assistant `tool_use` block named "Skill" (`input.skill`),
//     or a user slash command (`<command-name>/skill</command-name>`).
//   - Codex: a `function_call` whose arguments read `…/skills/<name>/SKILL.md`.

import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { Db } from "./db.ts";
import { isAssistantPrompt } from "./assistant-prompts.ts";

const DAY = 86_400_000;

export const SKILLS_WINDOW_DAYS = 90;

// Budget: the assistant prompt travels as one process argument, so the whole
// evidence stays well below the platform's per-argument limit.
const MAX_USER_SKILLS = 100;
const MAX_PLUGIN_SKILLS = 120;
const MAX_PROMPTS = 120;
const MAX_UNLISTED = 20;
const MAX_EVIDENCE_CHARS = 110_000;
const PROMPT_CHARS = 280;
const DESCRIPTION_CHARS = 240;
const PLUGIN_DESCRIPTION_CHARS = 160;
const BODY_HEAD_CHARS = 240;

export interface SkillSources {
  /** Directories whose children are skill folders (`<dir>/<name>/SKILL.md`). */
  userRoots: { dir: string; label: string }[];
  /** Claude plugin cache: `<dir>/<marketplace>/<plugin>/<version>/skills/<name>`. */
  pluginDir: string;
  /** Repository roots; their `.claude/skills` and `.agents/skills` are scanned. */
  repoPaths: string[];
  claudeDir: string;
  codexDir: string;
}

export function defaultSkillSources(repoPaths: string[] = []): SkillSources {
  const home = homedir();
  return {
    userRoots: [
      { dir: join(home, ".claude", "skills"), label: "~/.claude/skills" },
      { dir: join(home, ".agents", "skills"), label: "~/.agents/skills" },
      { dir: join(home, ".codex", "skills"), label: "~/.codex/skills" },
    ],
    pluginDir: join(home, ".claude", "plugins", "cache"),
    repoPaths,
    claudeDir: join(home, ".claude", "projects"),
    codexDir: join(home, ".codex", "sessions"),
  };
}

// ---- inventory ----

export type SkillOrigin = "user" | "project" | "plugin";

export interface SkillInfo {
  name: string;
  description: string;
  origin: SkillOrigin;
  /** Where it lives: a root label, a repo name or `marketplace/plugin`. */
  where: string;
  /** Plugin name for plugin skills: the unit one would disable. */
  plugin: string | null;
  modified_ms: number;
  bytes: number;
  /** First lines of the skill text, for judging what it is about. */
  head: string;
}

/** `name` and `description` of a SKILL.md, without a YAML dependency. Handles
 *  quoted values and `|` / `>` block scalars. */
export function parseSkillFile(text: string): { name: string | null; description: string; body: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const meta: Record<string, string> = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") { end = i; break; }
    if (end > 0) {
      bodyStart = end + 1;
      for (let i = 1; i < end; i++) {
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
        if (!m) continue;
        let value = m[2].trim();
        if (/^[|>][+-]?$/.test(value)) {
          const block: string[] = [];
          while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
          value = block.join(" ").replace(/\s+/g, " ").trim();
        } else if (/^(["']).*\1$/.test(value)) {
          value = value.slice(1, -1);
        }
        meta[m[1]] = value;
      }
    }
  }
  return { name: meta.name || null, description: meta.description ?? "", body: lines.slice(bodyStart).join("\n").trim() };
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function childDirs(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  // statSync follows symlinks: a linked skill folder is still a skill.
  return names.filter((n) => !n.startsWith(".") && isDir(join(dir, n))).sort();
}

function readSkill(dir: string, origin: SkillOrigin, where: string, plugin: string | null): SkillInfo | null {
  const file = join(dir, "SKILL.md");
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    const parsed = parseSkillFile(readFileSync(file, "utf8"));
    const limit = origin === "plugin" ? PLUGIN_DESCRIPTION_CHARS : DESCRIPTION_CHARS;
    return {
      name: parsed.name ?? basename(dir),
      description: parsed.description.slice(0, limit),
      origin,
      where,
      plugin,
      modified_ms: Math.round(st.mtimeMs),
      bytes: st.size,
      head: origin === "plugin" ? "" : parsed.body.replace(/\s+/g, " ").slice(0, BODY_HEAD_CHARS),
    };
  } catch {
    return null;
  }
}

/** Every skill reachable from the sources: one entry per real file, plugin
 *  skills collapsed to their newest cached version. */
export function inventorySkills(sources: SkillSources): SkillInfo[] {
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  const add = (dir: string, origin: SkillOrigin, where: string, plugin: string | null) => {
    let real: string;
    try { real = realpathSync(join(dir, "SKILL.md")); } catch { return; }
    if (seen.has(real)) return;
    const info = readSkill(dir, origin, where, plugin);
    if (!info) return;
    seen.add(real);
    out.push(info);
  };

  for (const root of sources.userRoots) for (const name of childDirs(root.dir)) add(join(root.dir, name), "user", root.label, null);

  for (const repo of sources.repoPaths) {
    for (const sub of [".claude/skills", ".agents/skills"]) {
      for (const name of childDirs(join(repo, sub))) add(join(repo, sub, name), "project", `${basename(repo)}/${sub}`, null);
    }
  }

  // Plugin cache keeps every installed version: keep the newest per skill.
  const newest = new Map<string, { dir: string; where: string; plugin: string; mtime: number }>();
  for (const market of childDirs(sources.pluginDir)) {
    for (const plugin of childDirs(join(sources.pluginDir, market))) {
      if (plugin.startsWith("temp_git_")) continue;
      for (const version of childDirs(join(sources.pluginDir, market, plugin))) {
        const skillsDir = join(sources.pluginDir, market, plugin, version, "skills");
        for (const name of childDirs(skillsDir)) {
          const dir = join(skillsDir, name);
          let mtime = 0;
          try { mtime = statSync(join(dir, "SKILL.md")).mtimeMs; } catch { continue; }
          const key = `${market}/${plugin}/${name}`;
          const prev = newest.get(key);
          if (!prev || mtime > prev.mtime) newest.set(key, { dir, where: `${market}/${plugin}`, plugin, mtime });
        }
      }
    }
  }
  for (const entry of [...newest.values()].sort((a, b) => a.dir.localeCompare(b.dir))) add(entry.dir, "plugin", entry.where, entry.plugin);
  return out;
}

// ---- session scanning ----

export type SkillVia = "tool" | "slash" | "file-read";

export interface SkillInvocation {
  /** Skill name without any `plugin:` prefix. */
  skill: string;
  plugin: string | null;
  ms: number;
  via: SkillVia;
}

export interface SessionFacts {
  agent: "claude" | "codex";
  session: string;
  project: string | null;
  first_ms: number | null;
  invocations: SkillInvocation[];
  /** First human prompt, cleaned and truncated; null when none was found. */
  prompt: string | null;
}

/** Strip boilerplate and secrets from a prompt before it leaves the machine or
 *  is stored with the digest. Corral-dispatched sessions open with the task
 *  text followed by Corral's conventions, which carry the API bearer token. */
export function cleanPrompt(raw: string): string | null {
  let text = raw;
  const boilerplate = text.search(/(^|\n)#{1,3} Working with Corral\b/);
  if (boilerplate >= 0) text = text.slice(0, boilerplate);
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<\/?pasted_content[^>]*>/g, " ")
    .replace(/<\/?(?:local-command-[\w-]+|command-[\w-]+)>/g, " ")
    .replace(/\n---\s*$/, " ")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|ghp|gho|ghs|ghu|glpat|xox[abprs]|AKIA)[-_A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/\b(token|secret|password|passwd|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1$2[redacted]")
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > PROMPT_CHARS ? `${text.slice(0, PROMPT_CHARS - 1)}…` : text;
}

function splitSkill(raw: string): { skill: string; plugin: string | null } {
  const i = raw.lastIndexOf(":");
  return i > 0 ? { plugin: raw.slice(0, i), skill: raw.slice(i + 1) } : { plugin: null, skill: raw };
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n");
}

const SKIPPED_PROMPT = /^\s*(<(?:command-|local-command|system-reminder|environment_context|INSTRUCTIONS|user_instructions)|Caveat:|\[Request interrupted|# AGENTS\.md instructions)/;

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Facts of one Claude Code transcript. Lines are prefiltered by substring so
 *  the JSON of tool results and request snapshots is never parsed. */
export function parseClaudeSession(lines: Iterable<string>, session: string): SessionFacts {
  const facts: SessionFacts = { agent: "claude", session, project: null, first_ms: null, invocations: [], prompt: null };
  for (const line of lines) {
    const mentionsSkill = line.includes('"name":"Skill"');
    const mentionsCommand = line.includes("<command-name>");
    const wantsPrompt = facts.prompt === null && line.includes('"type":"user"');
    const wantsMeta = facts.project === null && line.includes('"cwd"');
    if (!mentionsSkill && !mentionsCommand && !wantsPrompt && !wantsMeta && facts.first_ms !== null) continue;
    const obj = parseJson(line);
    if (!obj) continue;
    const ms = parseTime(obj.timestamp);
    if (ms !== null && (facts.first_ms === null || ms < facts.first_ms)) facts.first_ms = ms;
    if (facts.project === null && typeof obj.cwd === "string") facts.project = basename(obj.cwd);
    const message = obj.message as { role?: unknown; content?: unknown } | undefined;
    if (obj.type === "assistant" && mentionsSkill && Array.isArray(message?.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        const input = block?.input as { skill?: unknown } | undefined;
        if (block?.type === "tool_use" && block.name === "Skill" && typeof input?.skill === "string" && ms !== null) {
          facts.invocations.push({ ...splitSkill(input.skill.trim()), ms, via: "tool" });
        }
      }
    } else if (obj.type === "user" && !obj.isMeta) {
      const text = textOf(message?.content);
      const command = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text);
      if (command && ms !== null && /^\s*<command-(?:message|name)>/.test(text)) {
        facts.invocations.push({ ...splitSkill(command[1]), ms, via: "slash" });
      } else if (facts.prompt === null && !obj.isSidechain && text && !SKIPPED_PROMPT.test(text)) {
        facts.prompt = cleanPrompt(text);
      }
    }
  }
  return facts;
}

const CODEX_SKILL_READ = /\/skills\/(?:\.system\/)?([A-Za-z0-9._-]+)\/SKILL\.md/g;

/** Facts of one Codex rollout. A skill counts when a tool call reads its
 *  SKILL.md; the skill listing in developer messages is ignored. */
export function parseCodexSession(lines: Iterable<string>, session: string): SessionFacts {
  const facts: SessionFacts = { agent: "codex", session, project: null, first_ms: null, invocations: [], prompt: null };
  for (const line of lines) {
    const isCall = line.includes('"function_call"') && line.includes("SKILL.md");
    const wantsPrompt = facts.prompt === null && line.includes('"role":"user"');
    const wantsMeta = facts.project === null && line.includes('"cwd"');
    if (!isCall && !wantsPrompt && !wantsMeta && facts.first_ms !== null) continue;
    const obj = parseJson(line);
    if (!obj) continue;
    const ms = parseTime(obj.timestamp);
    if (ms !== null && (facts.first_ms === null || ms < facts.first_ms)) facts.first_ms = ms;
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (obj.type === "session_meta" && typeof payload.cwd === "string") facts.project = basename(payload.cwd);
    if (obj.type !== "response_item") continue;
    if (isCall && payload.type === "function_call" && typeof payload.arguments === "string" && ms !== null) {
      for (const m of payload.arguments.matchAll(CODEX_SKILL_READ)) facts.invocations.push({ skill: m[1], plugin: null, ms, via: "file-read" });
    } else if (wantsPrompt && payload.type === "message" && payload.role === "user") {
      const text = Array.isArray(payload.content)
        ? (payload.content as Record<string, unknown>[]).map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n")
        : "";
      if (text && !SKIPPED_PROMPT.test(text)) facts.prompt = cleanPrompt(text);
    }
  }
  return facts;
}

function listJsonl(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

async function* readLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

interface CachedFile {
  size: number;
  mtimeMs: number;
  facts: SessionFacts;
}

/** Scans Claude and Codex session logs for skill use, re-reading only files
 *  that changed (size + mtime), like UsageScanner. Files untouched since the
 *  window opened cannot hold in-window events and are not parsed. */
export class SkillSessionScanner {
  private files = new Map<string, CachedFile>();
  private running: Promise<void> | null = null;
  private lastScan = 0;
  private oldestUnparsedMtime: number | null = null;
  private sources: Pick<SkillSources, "claudeDir" | "codexDir">;
  private windowMs: number;
  ready = false;

  constructor(sources: Pick<SkillSources, "claudeDir" | "codexDir">, windowDays = SKILLS_WINDOW_DAYS) {
    this.sources = sources;
    this.windowMs = windowDays * DAY;
  }

  /** Concurrent callers share one pass; throttled to once per 30s. */
  refresh(now = Date.now(), force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && this.ready && Date.now() - this.lastScan < 30_000) return Promise.resolve();
    this.running = this.scan(now).finally(() => {
      this.running = null;
      this.lastScan = Date.now();
      this.ready = true;
    });
    return this.running;
  }

  private async scan(now: number): Promise<void> {
    const since = now - this.windowMs;
    const jobs: [string, "claude" | "codex"][] = [
      ...listJsonl(this.sources.claudeDir).map((p): [string, "claude" | "codex"] => [p, "claude"]),
      ...listJsonl(this.sources.codexDir).map((p): [string, "claude" | "codex"] => [p, "codex"]),
    ];
    const seen = new Set<string>();
    this.oldestUnparsedMtime = null;
    for (const [path, agent] of jobs) {
      let st;
      try { st = statSync(path); } catch { continue; }
      seen.add(path);
      if (st.mtimeMs < since) {
        // Logs reach back before the window even if this file is skipped.
        if (this.oldestUnparsedMtime === null || st.mtimeMs < this.oldestUnparsedMtime) this.oldestUnparsedMtime = st.mtimeMs;
        this.files.delete(path);
        continue;
      }
      const cached = this.files.get(path);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) continue;
      try {
        const session = basename(path, ".jsonl");
        const parse = agent === "claude" ? parseClaudeSession : parseCodexSession;
        this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, facts: parse(await collect(readLines(path)), session) });
      } catch {
        // An unreadable file is skipped; the next pass retries it.
      }
    }
    for (const path of [...this.files.keys()]) if (!seen.has(path)) this.files.delete(path);
  }

  sessions(): SessionFacts[] {
    return [...this.files.values()].map((f) => f.facts);
  }

  /** True when a log file older than the window exists, i.e. history is not
   *  cut off inside the window. */
  hasOlderLogs(): boolean {
    return this.oldestUnparsedMtime !== null;
  }
}

async function collect(lines: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

// ---- evidence ----

export interface SkillEvidenceRow {
  name: string;
  origin: SkillOrigin;
  where: string;
  plugin: string | null;
  description: string;
  head?: string;
  modified_ms: number;
  bytes: number;
  uses_30d: number;
  uses_window: number;
  sessions_window: number;
  last_used_ms: number | null;
}

export interface SkillsEvidence {
  generated_ms: number;
  window_days: number;
  window_start_ms: number;
  /** Earliest moment the scanned logs are known to cover; "unused" claims
   *  only hold from here on. */
  coverage_start_ms: number | null;
  /** Sessions scanned are those with activity in the window; some started before it. */
  logs: { sessions_scanned: number; sessions_started_in_window: number; corral_assistant_runs_excluded: number; scanning: boolean };
  skills: SkillEvidenceRow[];
  /** Skills invoked in the window that match no inventoried skill: removed
   *  skills, built-in commands or a source this scan does not read. */
  unlisted_invocations: { name: string; uses: number; last_used_ms: number }[];
  prompts: { ms: number; agent: string; project: string | null; text: string }[];
  limits: { user_skills: number; plugin_skills: number; prompts: number; max_chars: number };
  truncated: { skills: boolean; prompts: boolean; unlisted: boolean };
  gaps: string[];
}

export interface EvidenceInput {
  inventory: SkillInfo[];
  sessions: SessionFacts[];
  hasOlderLogs: boolean;
  scanning?: boolean;
  now: number;
  days?: number;
}

const ORIGIN_RANK: Record<SkillOrigin, number> = { user: 0, project: 1, plugin: 2 };

export function buildSkillsEvidence(input: EvidenceInput): SkillsEvidence {
  const { inventory, now } = input;
  // Corral's own assistant calls (summaries, the two digests) land in the same
  // logs. They are not the human's work: their prompts and any skill the
  // headless run invoked would skew both usage and the recurring-work signal.
  const sessions = input.sessions.filter((s) => !isAssistantPrompt(s.prompt));
  const assistantRuns = input.sessions.length - sessions.length;
  const days = input.days ?? SKILLS_WINDOW_DAYS;
  const since = now - days * DAY;
  const since30 = now - 30 * DAY;
  const byName = new Map<string, SkillInfo[]>();
  for (const skill of inventory) byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill]);

  const stats = new Map<SkillInfo, { uses30: number; uses: number; sessions: Set<string>; last: number | null }>();
  for (const skill of inventory) stats.set(skill, { uses30: 0, uses: 0, sessions: new Set(), last: null });
  const unlisted = new Map<string, { uses: number; last: number }>();
  const startedInWindow = sessions.filter((s) => s.first_ms !== null && s.first_ms >= since).length;

  for (const s of sessions) {
    for (const inv of s.invocations) {
      if (inv.ms < since || inv.ms > now) continue;
      let candidates = byName.get(inv.skill) ?? [];
      if (inv.plugin) {
        const exact = candidates.filter((c) => c.plugin === inv.plugin);
        if (exact.length) candidates = exact;
      }
      if (!candidates.length) {
        // A slash command that matches no skill is a built-in (/model, /clear…).
        if (inv.via === "slash") continue;
        const key = inv.plugin ? `${inv.plugin}:${inv.skill}` : inv.skill;
        const prev = unlisted.get(key);
        unlisted.set(key, { uses: (prev?.uses ?? 0) + 1, last: Math.max(prev?.last ?? 0, inv.ms) });
        continue;
      }
      for (const skill of candidates) {
        const st = stats.get(skill)!;
        st.uses += 1;
        if (inv.ms >= since30) st.uses30 += 1;
        st.sessions.add(`${s.agent}:${s.session}`);
        st.last = Math.max(st.last ?? 0, inv.ms);
      }
    }
  }

  const rows = (list: SkillInfo[], cap: number): SkillEvidenceRow[] =>
    list.slice(0, cap).map((skill) => {
      const st = stats.get(skill)!;
      return {
        name: skill.name,
        origin: skill.origin,
        where: skill.where,
        plugin: skill.plugin,
        description: skill.description.slice(0, skill.origin === "plugin" ? PLUGIN_DESCRIPTION_CHARS : DESCRIPTION_CHARS),
        ...(skill.head ? { head: skill.head.slice(0, BODY_HEAD_CHARS) } : {}),
        modified_ms: skill.modified_ms,
        bytes: skill.bytes,
        uses_30d: st.uses30,
        uses_window: st.uses,
        sessions_window: st.sessions.size,
        last_used_ms: st.last,
      };
    });
  const sorted = [...inventory].sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || a.name.localeCompare(b.name));
  const owned = sorted.filter((s) => s.origin !== "plugin");
  const plugin = sorted.filter((s) => s.origin === "plugin");

  const seenPrompts = new Set<string>();
  const prompts = sessions
    .filter((s): s is SessionFacts & { prompt: string; first_ms: number } => s.prompt !== null && s.first_ms !== null && s.first_ms >= since)
    .sort((a, b) => b.first_ms - a.first_ms)
    .filter((s) => {
      const key = s.prompt.slice(0, 80).toLowerCase();
      if (seenPrompts.has(key)) return false;
      seenPrompts.add(key);
      return true;
    });

  const firsts = sessions.map((s) => s.first_ms).filter((ms): ms is number => ms !== null);
  const earliest = firsts.length ? Math.min(...firsts) : null;
  const coverage = earliest === null && !input.hasOlderLogs ? null : input.hasOlderLogs ? since : Math.max(since, earliest!);

  const unlistedRows = [...unlisted.entries()].map(([name, v]) => ({ name, uses: v.uses, last_used_ms: v.last })).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  const evidence: SkillsEvidence = {
    generated_ms: now,
    window_days: days,
    window_start_ms: since,
    coverage_start_ms: coverage,
    logs: { sessions_scanned: sessions.length, sessions_started_in_window: startedInWindow, corral_assistant_runs_excluded: assistantRuns, scanning: input.scanning ?? false },
    skills: [...rows(owned, MAX_USER_SKILLS), ...rows(plugin, MAX_PLUGIN_SKILLS)],
    unlisted_invocations: unlistedRows.slice(0, MAX_UNLISTED),
    prompts: prompts.slice(0, MAX_PROMPTS).map((s) => ({ ms: s.first_ms, agent: s.agent, project: s.project, text: s.prompt })),
    limits: { user_skills: MAX_USER_SKILLS, plugin_skills: MAX_PLUGIN_SKILLS, prompts: MAX_PROMPTS, max_chars: MAX_EVIDENCE_CHARS },
    truncated: { skills: owned.length > MAX_USER_SKILLS || plugin.length > MAX_PLUGIN_SKILLS, prompts: prompts.length > MAX_PROMPTS, unlisted: unlistedRows.length > MAX_UNLISTED },
    gaps: [
      "Only structured invocations are counted: the Claude Skill tool, Claude slash commands and Codex reads of a SKILL.md. A skill an agent applied from its own listing without invoking it is not counted.",
      "OpenCode sessions are not scanned; their skill use is not in this evidence.",
      "Session logs can be pruned: read unused as 'unused since coverage_start_ms', never as 'never used'.",
      "Prompts are the first human message of each session, cleaned of boilerplate and secrets and truncated; they show what was asked, not how it ended.",
    ],
  };
  // Last guard on the prompt size. Prompts go first (the most replaceable),
  // then the tail of the skill list, which holds plugin skills before owned ones.
  const tooBig = () => JSON.stringify(evidence).length > MAX_EVIDENCE_CHARS;
  while (evidence.prompts.length > 10 && tooBig()) {
    evidence.prompts.length = Math.floor(evidence.prompts.length * 0.8);
    evidence.truncated.prompts = true;
  }
  while (evidence.skills.length > 20 && tooBig()) {
    evidence.skills.length = Math.floor(evidence.skills.length * 0.9);
    evidence.truncated.skills = true;
  }
  return evidence;
}

/** Evidence source for the analysis: inventories the skills and scans the
 *  session logs on every call, reusing the scanner's per-file cache. */
export function skillsEvidenceSource(db: Pick<Db, "listRepos">, sources: Partial<SkillSources> = {}): (now?: number) => Promise<SkillsEvidence> {
  let scanner: SkillSessionScanner | null = null;
  return async (now = Date.now()) => {
    const resolved = { ...defaultSkillSources(db.listRepos().map((r) => r.path).filter((p) => existsSync(p))), ...sources };
    scanner ??= new SkillSessionScanner(resolved);
    // A first scan of large logs can take a while: use what is indexed by then.
    await Promise.race([scanner.refresh(now), new Promise<void>((resolve) => setTimeout(resolve, 60_000).unref())]);
    return buildSkillsEvidence({ inventory: inventorySkills(resolved), sessions: scanner.sessions(), hasOlderLogs: scanner.hasOlderLogs(), scanning: !scanner.ready, now });
  };
}
