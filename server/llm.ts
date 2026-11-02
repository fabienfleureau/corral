// Corral's own LLM calls (item summarization) run headless through the
// configured assistant command — inside your subscription budget.

import { execFile } from "node:child_process";
import type { Config } from "./config.ts";

export function llmComplete(cfg: Config, prompt: string, timeoutMs = 120000): Promise<string> {
  const argv = cfg.assistant.map((p) => p.replaceAll("{prompt}", prompt));
  const [cmd, ...args] = argv;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`assistant command failed (${cmd}): ${err.message}\n${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function summarizeText(cfg: Config, text: string, title: string): Promise<string> {
  const prompt = [
    "You are a helper inside a personal inbox app. Below is the recent terminal output of an",
    "AI coding agent that has stopped and needs its human. Summarize for the human:",
    "1) the single question or decision the agent is waiting on (one sentence),",
    "2) the minimum context needed to answer (2-4 sentences).",
    "No preamble, no transcript, no markdown headers.",
    "",
    `Task title: ${title}`,
    "",
    "--- terminal output ---",
    text.slice(-8000),
  ].join("\n");
  return llmComplete(cfg, prompt);
}
