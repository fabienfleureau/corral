// Async subprocesses for platform CLIs (gh, glab, git): a stuck call must
// not block HTTP requests, SSE or worker polling.

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export function runAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; allowFailure?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", cwd: opts.cwd, timeout: opts.timeout ?? 20_000, maxBuffer: 32 * 1024 * 1024 },
      // Some CLIs print structured output even when exiting non-zero.
      (err, stdout) => (err && !opts.allowFailure ? reject(err) : resolve(stdout.trim())),
    );
  });
}

/**
 * Absolute path of a CLI installed outside the server's PATH. A server started
 * from a GUI (or tmux without a login shell) gets a bare PATH: user installs
 * like `~/.opencode/bin` are missing, so a bare `execFile(name)` fails there.
 */
export function resolveExecutable(name: string, extraDirs: string[] = []): string | null {
  const dirs = [...(process.env.PATH ?? "").split(":"), ...extraDirs];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here — try the next directory.
    }
  }
  return null;
}

/** Map with at most `limit` calls in flight; keeps input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
