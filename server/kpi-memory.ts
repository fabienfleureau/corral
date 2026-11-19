import { closeSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KpiId } from "../shared/kpis.ts";

/** The UI and the report contract keep a bounded copy; the file holds the full note. */
export const MAX_MEMORY_CHARS = 3500;
const READ_BYTES = 20_000;

export function kpiMemoryPath(id: KpiId, repoPath: string): string {
  return join(repoPath, ".corral", `${id}-memory.md`);
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

export interface PreparedMemory {
  path: string;
  excerpt: string;
}

/** Seed the workspace note from SQLite on first use, then let the file lead. */
export function prepareMemory(id: KpiId, repoPath: string, previous: string): PreparedMemory {
  const path = kpiMemoryPath(id, repoPath);
  const current = readMemoryFile(path);
  if (current === null) writeMemoryFile(path, previous);
  const content = current ?? previous;
  return { path, excerpt: content.slice(0, MAX_MEMORY_CHARS) };
}

/** The file leads once it has notes; the JSON field seeds an empty file. */
export function persistMemory(id: KpiId, repoPath: string, reported: string): string {
  const path = kpiMemoryPath(id, repoPath);
  const current = readMemoryFile(path);
  if (current !== null && current.trim() !== "") return current.slice(0, MAX_MEMORY_CHARS);
  writeMemoryFile(path, reported);
  return reported.slice(0, MAX_MEMORY_CHARS);
}

/** Redefinition starts fresh research, including the workspace note. */
export function clearMemory(id: KpiId, repoPath: string): void {
  if (!repoPath) return;
  rmSync(kpiMemoryPath(id, repoPath), { force: true });
}
