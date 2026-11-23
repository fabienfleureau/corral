import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The UI and the report contract keep a bounded copy; the file holds the full note. */
export const MAX_EPIC_AGENT_MEMORY_CHARS = 3500;
const READ_BYTES = 20_000;

export function epicAgentSlug(jiraKey: string): string {
  const cleaned = jiraKey.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "epic";
}

export function epicAgentMemoryPath(jiraKey: string, repoPath: string): string {
  return join(repoPath, ".corral", `epic-${epicAgentSlug(jiraKey)}-memory.md`);
}

function readMemoryFile(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(READ_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function writeMemoryFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export interface PreparedEpicMemory {
  path: string;
  excerpt: string;
}

/** Seed the workspace note from SQLite on first use, then let the file lead. */
export function prepareEpicMemory(jiraKey: string, repoPath: string, previous: string): PreparedEpicMemory {
  const path = epicAgentMemoryPath(jiraKey, repoPath);
  const current = readMemoryFile(path);
  if (current === null) writeMemoryFile(path, previous);
  const content = current ?? previous;
  return { path, excerpt: content.slice(0, MAX_EPIC_AGENT_MEMORY_CHARS) };
}

/** The file leads once it has notes; the JSON field seeds an empty file. */
export function persistEpicMemory(jiraKey: string, repoPath: string, reported: string): string {
  const path = epicAgentMemoryPath(jiraKey, repoPath);
  const current = readMemoryFile(path);
  if (current !== null && current.trim() !== "") return current.slice(0, MAX_EPIC_AGENT_MEMORY_CHARS);
  writeMemoryFile(path, reported);
  return reported.slice(0, MAX_EPIC_AGENT_MEMORY_CHARS);
}
