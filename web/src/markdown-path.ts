// Absolute Markdown paths in task text become links to the local file viewer.
// Plain prose only matches whitespace-free paths; a path with spaces can be
// wrapped in backticks and is then matched as one inline-code token.

const WHOLE_PATH_RE = /^\/[^\r\n<>"'`*]+\.(?:md|markdown)$/i;
export const INLINE_PATH_RE = /\/[\w.~+@%$-]+(?:\/[\w.~+@%$-]+)*\.(?:md|markdown)\b/gi;

export function isMarkdownPath(value: string): boolean {
  const path = value.trim();
  return WHOLE_PATH_RE.test(path) && !path.includes("://");
}
