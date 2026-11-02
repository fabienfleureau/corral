// Corral configuration. File: ~/.config/corral/config.json, merged over defaults.
// Env overrides: CORRAL_PORT, CORRAL_TOKEN, CORRAL_HOST, HERDR_SOCKET, CORRAL_DATA_DIR.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
  jql: string;
}

export interface Config {
  port: number;
  host: string;
  token: string;
  herdrSocket: string;
  configDir: string;
  dataDir: string;
  worktreesDir: string;
  /** Agent launch commands. "{prompt}" is replaced with the task prompt. */
  agents: Record<string, string[]>;
  /** Corral's own LLM calls (summarization). "{prompt}" placeholder. */
  assistant: string[];
  jira: JiraConfig;
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
    agents: {
      claude: ["claude", "{prompt}"],
      codex: ["codex", "{prompt}"],
      opencode: ["opencode", "{prompt}"],
    },
    assistant: ["claude", "-p", "{prompt}"],
    jira: { baseUrl: "", email: "", token: "", jql: "" },
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
