// Files attached to a task prompt (a dropped screenshot, a log, a PDF).
//
// Corral stores them with the task and hands them to the worker backend at
// dispatch; omnigent turns them into `input_image` / `input_file` message
// parts. The allowlist and size caps mirror omnigent's upload route
// (`omnigent/runtime/content_resolver.py`), which is the authority: checking
// here means an unsupported file fails when the task is created, not after a
// session already exists. `web/src/attachments.ts` is the client copy.

export type AttachmentCategory = "image" | "pdf" | "text";

/** Per-type size caps, in bytes. Same numbers as omnigent. */
export const ATTACHMENT_LIMITS: Record<AttachmentCategory, number> = {
  image: 5 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 10 * 1024 * 1024,
};

/** Files per task. Every attachment is re-sent to the model on each turn. */
export const MAX_ATTACHMENTS = 10;

/** All files of one task together: omnigent's per-request ceiling. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;

/** Request body ceiling for a task created with attachments: the raw total as
 *  base64 (4/3) plus room for the JSON around it. */
export const MAX_TASK_BODY_BYTES = Math.ceil((MAX_ATTACHMENT_TOTAL_BYTES * 4) / 3) + 1024 * 1024;

/** The image types every model provider reads. Anything else (HEIC, TIFF, BMP)
 *  would be stored and then rejected by the model mid-turn. */
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const TEXT_LIKE_APPLICATION = new Set([
  "application/json",
  "application/javascript",
  "application/jsonl",
  "application/x-ndjson",
  "application/x-ipynb+json",
]);

/** Text/code extensions whose browser MIME is often empty or wrong (`.ts`
 *  reports video/mp2t). Same list as omnigent. */
export const TEXT_EXTENSIONS = new Set([
  ".txt", ".log", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".env", ".lock", ".proto", ".graphql", ".gql", ".html", ".htm", ".xml",
  ".css", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".scala", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".pl", ".r", ".jl", ".lua",
  ".ex", ".exs", ".erl", ".hs", ".clj", ".dart", ".vue", ".svelte", ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".tf", ".hcl", ".gradle", ".dockerfile", ".ipynb", ".svg",
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

/** The category a file belongs to, or null when it cannot be attached
 *  (office documents, archives, binaries). The declared MIME wins; the
 *  extension rescues text files a browser mislabelled. */
export function classifyAttachment(filename: string, contentType: string): AttachmentCategory | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) return "image";
  if (type === "application/pdf" || extensionOf(filename) === ".pdf") return "pdf";
  // An SVG is source the agent can read, not a picture a model can see.
  if (type === "image/svg+xml") return "text";
  if (type.startsWith("text/") || TEXT_LIKE_APPLICATION.has(type) || TEXT_EXTENSIONS.has(extensionOf(filename))) {
    return "text";
  }
  return null;
}

/** A name safe to store and to show: no directories, no control characters,
 *  no brackets (omnigent matches `[Attached: name]` markers by regex). */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = clipName(base.replace(/[\u0000-\u001f\u007f[\]]/g, "_").trim());
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

const MAX_NAME_CHARS = 200;

/** Shorten a long name by cutting its stem: the extension decides how a text
 *  file is read, so it must survive. */
function clipName(name: string): string {
  if (name.length <= MAX_NAME_CHARS) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 20 ? name.slice(dot) : "";
  return name.slice(0, MAX_NAME_CHARS - ext.length) + ext;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What the client sends inside `POST /api/tasks`. */
export interface AttachmentInput {
  filename: string;
  content_type: string;
  /** File bytes, base64 encoded. */
  data: string;
}

export interface ValidAttachment {
  filename: string;
  content_type: string;
  data: Buffer;
}

export type AttachmentCheck = { ok: true; files: ValidAttachment[] } | { ok: false; status: number; error: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validate and decode the attachments of a new task. All or nothing: the
 *  first problem rejects the request so no task is created half-attached. */
export function checkAttachments(input: unknown): AttachmentCheck {
  if (input === undefined || input === null) return { ok: true, files: [] };
  if (!Array.isArray(input)) return { ok: false, status: 400, error: "attachments must be an array" };
  if (input.length > MAX_ATTACHMENTS) {
    return { ok: false, status: 400, error: `at most ${MAX_ATTACHMENTS} attachments per task` };
  }
  const files: ValidAttachment[] = [];
  let total = 0;
  for (const raw of input as Partial<AttachmentInput>[]) {
    if (!raw || typeof raw.filename !== "string" || typeof raw.data !== "string") {
      return { ok: false, status: 400, error: "each attachment needs a filename and base64 data" };
    }
    const filename = safeFilename(raw.filename);
    const declared = typeof raw.content_type === "string" ? raw.content_type : "";
    const category = classifyAttachment(filename, declared);
    if (!category) {
      return { ok: false, status: 415, error: `"${filename}" can't be attached: only PNG, JPEG, GIF and WebP images, PDF and text/code files are supported` };
    }
    if (!BASE64.test(raw.data)) return { ok: false, status: 400, error: `"${filename}" is not valid base64` };
    const data = Buffer.from(raw.data, "base64");
    if (data.length === 0) return { ok: false, status: 400, error: `"${filename}" is empty` };
    if (data.length > ATTACHMENT_LIMITS[category]) {
      return { ok: false, status: 413, error: `"${filename}" is too large: the limit for ${category} files is ${ATTACHMENT_LIMITS[category] / 1024 / 1024} MB` };
    }
    total += data.length;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
      return { ok: false, status: 413, error: `attachments are too large together: the limit is ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB per task` };
    }
    files.push({ filename, content_type: normalizedType(category, declared), data });
  }
  return { ok: true, files };
}

/** The MIME stored with the file. A mislabelled text file is stored as
 *  text/plain so omnigent inlines it as text; images and PDFs keep their type. */
function normalizedType(category: AttachmentCategory, declared: string): string {
  const type = declared.split(";")[0].trim().toLowerCase();
  if (category === "pdf") return "application/pdf";
  if (category === "image") return type;
  return type.startsWith("text/") || TEXT_LIKE_APPLICATION.has(type) ? type : "text/plain";
}
