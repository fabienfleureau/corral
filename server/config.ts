// Corral configuration. File: ~/.config/corral/config.json, merged over defaults.
// Env overrides: CORRAL_PORT, CORRAL_TOKEN, CORRAL_HOST, HERDR_SOCKET, CORRAL_DATA_DIR.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Favorite } from "./favorites.ts";
import type { JiraStage } from "./jira-status.ts";
import type { Reviewer } from "./reviewers.ts";
import type { ModelFacts } from "./model-catalog.ts";
import type { ModelPrice } from "./usage.ts";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
  jql: string;
  /** Corral lifecycle stage -> Jira status name (a project's workflow names
   *  its statuses itself). Defaults: To Do, In Progress, Code Review,
   *  Ready to merge, Done; a blank name disables that stage. */
  statuses?: Partial<Record<JiraStage, string>>;
}

export interface OmnigentConfig {
  baseUrl: string;
  /** Bearer token (machine token / login token); empty = unauthenticated. */
  token: string;
  /** Host id for worktree creation (session create with git options needs it). */
  hostId: string;
  /** harness id -> omnigent agent registration + optional harness override. */
  agents: Record<string, { agentId?: string; harness?: string }>;
  /** Local model servers to probe for availability: provider id -> base URL
   *  (e.g. "ornith-local": "http://192.168.10.241:8080/v1"). */
  localProviders?: Record<string, string>;
}

export interface Config {
  favorites?: Favorite[];
  /** Named reviews (a command, or a delegate sub-agent); a favorite picks one by name. */
  reviewers?: Reviewer[];
  /** Model facts catalog overrides (exact id or "prefix*"), merged over the
   *  shipped defaults per model key. */
  models?: Record<string, ModelFacts>;
  port: number;
  host: string;
  token: string;
  herdrSocket: string;
  configDir: string;
  dataDir: string;
  worktreesDir: string;
  /** Directories scanned for git repos by POST /api/repos/scan. */
  workspaceRoots: string[];
  /** Agent launch commands. "{prompt}" is replaced with the task prompt. */
  agents: Record<string, string[]>;
  /** Corral's own LLM calls (summarization). "{prompt}" placeholder. */
  assistant: string[];
  jira: JiraConfig;
  omnigent: OmnigentConfig;
  /** Usage page: price overrides (USD per MTok), by exact model id or "prefix*". */
  usage: { prices: Record<string, ModelPrice> };
}

function defaultConfig(): Config {
  const home = homedir();
  const configDir = join(home, ".config", "corral");
  return {
    port: 4787,
    host: "127.0.0.1",
    token: "",
    herdrSocket: join(home, ".local", "state", "herdr-core", "default", "default.sock"),
    configDir,
    dataDir: join(home, ".local", "share", "corral"),
    worktreesDir: join(home, ".herdr", "worktrees"),
    workspaceRoots: [join(home, "workspace")],
    agents: {
      claude: ["claude", "{prompt}"],
      codex: ["codex", "{prompt}"],
      opencode: ["opencode", "{prompt}"],
    },
    assistant: ["claude", "-p", "{prompt}"],
    jira: { baseUrl: "", email: "", token: "", jql: "", statuses: {} },
    omnigent: {
      baseUrl: "http://127.0.0.1:6767",
      token: "",
      hostId: "",
      localProviders: {},
      agents: {
        claude: { harness: "claude-native" },
        codex: { harness: "codex-native" },
        opencode: { harness: "opencode-native" },
      },
    },
    usage: { prices: {} },
    models: {},
    reviewers: [
      { name: "cubic", command: "cubic review --base {base_branch} --json" },
      { name: "ocr", command: "ocr review --from {base_branch} --provider chatgpt --model gpt-6.1-sol --effort medium --audience agent --format json" },
      // `ocr delegate` calls no model: the sub-agent's own harness does the review.
      { name: "ocr-claude", delegate: "claude" },
      { name: "ocr-codex", delegate: "codex" },
    ],
  };
}

function deepMerge<T>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(): Config {
  const defaults = defaultConfig();
  const configPath = join(defaults.configDir, "config.json");
  let cfg = defaults;
  if (existsSync(configPath)) {
    try {
      const patch = JSON.parse(readFileSync(configPath, "utf8"));
      cfg = deepMerge(defaults, patch);
    } catch (err) {
      console.error(`corral: could not parse ${configPath}: ${String(err)}`);
    }
  }
  // First run: generate a token and persist it so the CLI and web UI can share it.
  // Persist BEFORE applying env overrides — env must never leak into the file.
  if (!cfg.token && !process.env.CORRAL_TOKEN) {
    cfg.token = randomBytes(24).toString("hex");
    mkdirSync(cfg.configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ ...cfg, assistant: cfg.assistant, agents: cfg.agents }, null, 2) + "\n",
    );
    console.log(`corral: first run — wrote ${configPath} (token generated)`);
  } else if (!existsSync(configPath)) {
    mkdirSync(cfg.configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  }

  // Env overrides (runtime only)
  if (process.env.CORRAL_PORT) cfg.port = Number(process.env.CORRAL_PORT);
  if (process.env.CORRAL_HOST) cfg.host = process.env.CORRAL_HOST;
  if (process.env.CORRAL_TOKEN) cfg.token = process.env.CORRAL_TOKEN;
  if (process.env.HERDR_SOCKET) cfg.herdrSocket = process.env.HERDR_SOCKET;
  if (process.env.CORRAL_DATA_DIR) cfg.dataDir = process.env.CORRAL_DATA_DIR;

  mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}
