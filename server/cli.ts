#!/usr/bin/env node
// Corral CLI: capture work from wherever you are.
//   corral add "title" --repo ~/work/foo [--prompt "..."] [--target claude] [--jira KEY-1]
//   corral status
//   corral serve
//
// Talks to a running corral server over localhost (see ~/.config/corral/config.json).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CliConfig {
  port: number;
  host: string;
  token: string;
}

function loadCliConfig(): CliConfig {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".config", "corral", "config.json"), "utf8"));
    return {
      port: Number(process.env.CORRAL_PORT ?? cfg.port ?? 4787),
      host: process.env.CORRAL_HOST ?? cfg.host ?? "127.0.0.1",
      token: process.env.CORRAL_TOKEN ?? cfg.token ?? "",
    };
  } catch {
    return { port: Number(process.env.CORRAL_PORT ?? 4787), host: process.env.CORRAL_HOST ?? "127.0.0.1", token: process.env.CORRAL_TOKEN ?? "" };
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const cfg = loadCliConfig();
  const res = await fetch(`http://${cfg.host}:${cfg.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "add": {
      const title = rest.find((a) => !a.startsWith("--"));
      if (!title) throw new Error('usage: corral add "title" --repo <path> [--prompt "..."] [--target claude] [--jira KEY]');
      const task = await api<{ id: string }>("POST", "/api/tasks", {
        title,
        repo_path: arg("--repo") ?? process.cwd(),
        prompt: arg("--prompt") ?? "",
        target: arg("--target") ?? "",
        jira_key: arg("--jira") ?? null,
      });
      console.log(`task ${task.id} created`);
      if (has("--dispatch")) {
        const result = await api<{ address: string; branch: string }>("POST", `/api/tasks/${task.id}/dispatch`, {
          target: arg("--target"),
        });
        console.log(`dispatched -> ${result.address} (branch ${result.branch})`);
      }
      break;
    }
    case "status": {
      const [items, tasks] = await Promise.all([
        api<unknown[]>("GET", "/api/items?status=open"),
        api<unknown[]>("GET", "/api/tasks?status=open"),
      ]);
      console.log(`open inbox items: ${items.length}`);
      console.log(`open tasks:       ${tasks.length}`);
      break;
    }
    case "serve": {
      await import("./index.ts");
      break;
    }
    default:
      console.log("corral — feed your workers, answer from one inbox\n");
      console.log("usage:");
      console.log('  corral add "title" --repo <path> [--prompt "..."] [--target claude] [--jira KEY] [--dispatch]');
      console.log("  corral status");
      console.log("  corral serve");
  }
}

main().catch((err) => {
  console.error(`corral: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
