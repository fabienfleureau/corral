// Evidence shared out of Corral must not carry the local machine's paths,
// credentials or terminal output. Pure string logic, shared by the browser and
// the unit tests: no Node or DOM APIs, and no network calls.

export type RedactOptions = {
  /** Keep command/output blocks. Paths and secrets inside them are still redacted. */
  includeShellTranscripts?: boolean;
};

const REDACTED = "[redacted]";
const LOCAL_PATH = "[local path]";
const SHELL_OMITTED = "[shell transcript omitted]";

// A path token starts at a bare slash, never inside a scheme (`https://…`) or
// after a hostname. Both a local root and a worktree segment make it local.
const ABS_PATH_RE = /(?<![\w:/.@+%#-])\/(?:[A-Za-z0-9._~@%+#-]+\/)+[A-Za-z0-9._~@%+#-]+/g;
const HOME_PATH_RE = /(?:\$\{HOME\}|\$HOME|\$\{PWD\}|\$PWD|~)\/(?:[A-Za-z0-9._~@%+#-]+\/?)+/g;
const WORKTREE_RE = /(?<![\w/.-])(?:[A-Za-z0-9._~@%+#-]+\/)*corral-worktrees\/[A-Za-z0-9._~@%+#-]+(?:\/[A-Za-z0-9._~@%+#-]+)*/g;
const WINDOWS_PATH_RE = /(?<![\w])\b[A-Za-z]:\\(?:[A-Za-z0-9._~@%+#-]+\\)*[A-Za-z0-9._~@%+#-]+/g;
const FILE_URL_RE = /file:\/\/[^\s)<>`"']+/gi;

const LOCAL_ROOTS = new Set([
  "Users", "home", "root", "private", "tmp", "var", "opt", "Volumes", "mnt", "workspace", "workspaces",
]);

const SHELL_LANGS = new Set(["bash", "sh", "zsh", "shell", "console", "terminal", "powershell", "cmd", "fish"]);
const SHELL_PROMPT_RE = /^\s*(?:\$|❯|›)\s+/;
const BLOCK_STRUCTURE_RE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|\||```)/;

const SECRET_FIELD_RE = /\b(authorization|auth|api[_-]?key|access[_-]?key|secret(?:_key)?|password|passwd|token|cookie|private[_-]?key|client[_-]?secret)\b(\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|(?:(?:Bearer|Basic)\s+)?([^\s,;&)]+))/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const CLI_SECRET_RE = /(--[\w-]*(?:token|secret|password|key)(?:=|\s+))([^\s]+)/gi;
const QUERY_SECRET_RE = /([?&](?:token|secret|api[_-]?key|key|password|sig)=)([^&\s#)]+)/gi;
const NAMED_TOKEN_RE = /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function isLocalPath(path: string): boolean {
  return path.split("/").some((part) =>
    LOCAL_ROOTS.has(part) || part === "corral-worktrees" || part.endsWith("-worktrees") || part.endsWith("_worktrees"));
}

function redactPaths(text: string): string {
  return text
    .replace(FILE_URL_RE, LOCAL_PATH)
    .replace(HOME_PATH_RE, LOCAL_PATH)
    .replace(WINDOWS_PATH_RE, LOCAL_PATH)
    .replace(WORKTREE_RE, LOCAL_PATH)
    .replace(ABS_PATH_RE, (match) => isLocalPath(match) ? LOCAL_PATH : match);
}

function redactSecrets(text: string): string {
  return text
    // Field values first: "Authorization: Bearer <token>" becomes one redaction.
    .replace(SECRET_FIELD_RE, (_match, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(CLI_SECRET_RE, (_match, flag: string) => `${flag}${REDACTED}`)
    .replace(QUERY_SECRET_RE, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(NAMED_TOKEN_RE, REDACTED);
}

function redactShellTranscripts(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```([^\s`]*)/.exec(line);
    if (fence && SHELL_LANGS.has((fence[1] ?? "").toLowerCase())) {
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) i += 1;
      if (i < lines.length) i += 1;
      kept.push(SHELL_OMITTED);
      continue;
    }
    if (SHELL_PROMPT_RE.test(line)) {
      i += 1;
      // Command output follows the prompt until a blank line or new Markdown
      // structure. Consecutive prompts are one transcript, not several.
      while (i < lines.length && lines[i].trim() !== "" && !/^\s*```/.test(lines[i]) && !BLOCK_STRUCTURE_RE.test(lines[i])) i += 1;
      kept.push(SHELL_OMITTED);
      continue;
    }
    kept.push(line);
    i += 1;
  }
  return kept.join("\n");
}

/** Redact evidence once, so a copy and a downloaded file contain the same text. */
export function redactMarkdown(text: string, options: RedactOptions = {}): string {
  const withoutTranscripts = options.includeShellTranscripts ? text : redactShellTranscripts(text);
  return redactSecrets(redactPaths(withoutTranscripts));
}
