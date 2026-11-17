// Local Markdown files referenced in task text are served as text to the
// viewer. Only absolute paths with a Markdown extension are accepted; the
// endpoint is behind the normal /api token check.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const MAX_MARKDOWN_FILE_BYTES = 2 * 1024 * 1024;

export interface MarkdownFile {
  path: string;
  content: string;
}

export class MarkdownFileError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MarkdownFileError";
    this.status = status;
  }
}

function isMarkdownPath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

export function readMarkdownFile(raw: unknown): MarkdownFile {
  if (typeof raw !== "string" || !raw.trim()) throw new MarkdownFileError(400, "path required");
  const path = raw.trim();
  if (!isAbsolute(path) || path.includes("\0")) throw new MarkdownFileError(400, "path must be absolute");
  if (!isMarkdownPath(path)) throw new MarkdownFileError(400, "only .md and .markdown files can be viewed");

  let real: string;
  try {
    real = realpathSync(path);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new MarkdownFileError(404, "file not found");
    if (code === "EACCES" || code === "EPERM") throw new MarkdownFileError(403, "file cannot be read");
    throw new MarkdownFileError(400, "invalid path");
  }
  // A symlink named .md must not become a way to read any other file type.
  if (!isMarkdownPath(real)) throw new MarkdownFileError(400, "only .md and .markdown files can be viewed");
  try {
    const stat = statSync(real);
    if (!stat.isFile()) throw new MarkdownFileError(400, "not a file");
    if (stat.size > MAX_MARKDOWN_FILE_BYTES) throw new MarkdownFileError(413, "file is too large to view");
    return { path, content: readFileSync(real, "utf8") };
  } catch (err) {
    if (err instanceof MarkdownFileError) throw err;
    const code = (err as { code?: string }).code;
    if (code === "EACCES" || code === "EPERM") throw new MarkdownFileError(403, "file cannot be read");
    throw new MarkdownFileError(400, "file cannot be read");
  }
}
