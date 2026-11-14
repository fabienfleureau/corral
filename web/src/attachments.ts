// Files dropped on a task prompt: which can be attached and how big.
//
// Mirrors server/attachments.ts, which is the authority (the web bundle cannot
// import server code); server/test/attachments.test.ts keeps both copies in
// step. Checking here rejects a bad file at drop time with a plain message
// instead of after the request.

export type AttachmentCategory = "image" | "pdf" | "text";

export const ATTACHMENT_LIMITS: Record<AttachmentCategory, number> = {
  image: 5 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 10 * 1024 * 1024,
};
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;

/** What `POST /api/tasks` takes for one file. */
export type AttachmentInput = { filename: string; content_type: string; data: string };

/** The image types every model provider reads. Anything else (HEIC, TIFF, BMP)
 *  would be stored and then rejected by the model mid-turn. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const TEXT_LIKE_APPLICATION = new Set([
  "application/json",
  "application/javascript",
  "application/jsonl",
  "application/x-ndjson",
  "application/x-ipynb+json",
]);

const TEXT_EXTENSIONS = new Set([
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

/** The category a file belongs to, or null when it cannot be attached. The
 *  declared MIME wins; the extension rescues text files a browser mislabelled. */
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/** Add dropped, pasted or picked files to the ones already attached. A file
 *  that cannot be attached is left out and explained in `errors`. */
export function addAttachments(current: File[], incoming: File[]): { files: File[]; errors: string[] } {
  const files = [...current];
  const errors: string[] = [];
  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const file of incoming) {
    const name = file.name || "file";
    if (files.some((f) => sameFile(f, file))) continue;
    const category = classifyAttachment(name, file.type);
    if (!category) {
      errors.push(`"${name}" can't be attached: only PNG, JPEG, GIF and WebP images, PDF and text/code files are supported.`);
    } else if (file.size === 0) {
      errors.push(`"${name}" is empty.`);
    } else if (file.size > ATTACHMENT_LIMITS[category]) {
      errors.push(`"${name}" is too large: the limit for ${category} files is ${ATTACHMENT_LIMITS[category] / 1024 / 1024} MB.`);
    } else if (files.length >= MAX_ATTACHMENTS) {
      errors.push(`"${name}" was not attached: at most ${MAX_ATTACHMENTS} files per task.`);
    } else if (total + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
      errors.push(`"${name}" was not attached: files are limited to ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB together.`);
    } else {
      files.push(file);
      total += file.size;
    }
  }
  return { files, errors };
}
