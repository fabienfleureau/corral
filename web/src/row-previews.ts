// Pure extraction of safe thumbnail previews and KPI/Claude artifact badges for list rows.

export type PreviewImage = { url: string; alt: string; source: "attachment" | "markdown" };
export type ArtifactBadge = { kind: "kpi" | "artifact"; label: string; url?: string };

export const MAX_ROW_THUMBNAILS = 3;

const TASK_ATTACHMENT_RE = /^\/api\/tasks\/[^/\s]+\/attachments\/[^/\s]+$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/i;
const MD_IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;
const HTML_IMG_RE = /<img\b[^>]*>/gi;
const ATTR_SRC_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const ATTR_ALT_RE = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const CLAUDE_ARTIFACT_URL_RE = /https:\/\/claude\.ai\/(?:public\/)?artifacts\/[^\s<>"')]+/gi;

/** Allow only http(s) URLs or same-origin task attachment routes. */
export function isSafePreviewImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  return HTTP_URL_RE.test(trimmed) || TASK_ATTACHMENT_RE.test(trimmed);
}

/** Extract safe image URLs from Markdown `![alt](url)` and HTML `<img>` tags. */
export function extractMarkdownImages(text: string, max = MAX_ROW_THUMBNAILS): PreviewImage[] {
  if (!text || max <= 0) return [];
  const results: PreviewImage[] = [];
  const seen = new Set<string>();

  const push = (rawUrl: string, rawAlt: string) => {
    if (results.length >= max) return;
    const url = rawUrl.trim();
    if (!isSafePreviewImageUrl(url) || seen.has(url)) return;
    seen.add(url);
    results.push({ url, alt: rawAlt.trim() || "Preview image", source: "markdown" });
  };

  const mdRe = new RegExp(MD_IMAGE_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = mdRe.exec(text)) !== null) {
    push(match[2] ?? "", match[1] ?? "");
    if (results.length >= max) return results;
  }

  const htmlRe = new RegExp(HTML_IMG_RE.source, "gi");
  while ((match = htmlRe.exec(text)) !== null) {
    const tag = match[0];
    const srcMatch = ATTR_SRC_RE.exec(tag);
    const src = srcMatch?.[1] ?? srcMatch?.[2] ?? "";
    const altMatch = ATTR_ALT_RE.exec(tag);
    const alt = altMatch?.[1] ?? altMatch?.[2] ?? "";
    push(src, alt);
    if (results.length >= max) return results;
  }

  return results;
}

/** Build preview image descriptors for a task's stored image attachments. */
export function taskAttachmentPreviews(
  taskId: string,
  attachments?: { id: string; filename: string; content_type: string }[],
): PreviewImage[] {
  if (!taskId || !attachments?.length) return [];
  return attachments.map((attachment) => ({
    url: `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachment.id)}`,
    alt: attachment.filename || "Attachment",
    source: "attachment",
  }));
}

/** Combine attachment and markdown preview images, deduplicating by URL and capping at `max`. */
export function combineRowImages(
  attachments: PreviewImage[],
  markdown: PreviewImage[],
  max = MAX_ROW_THUMBNAILS,
): { visible: PreviewImage[]; extraCount: number } {
  const unique: PreviewImage[] = [];
  const seen = new Set<string>();
  for (const image of [...attachments, ...markdown]) {
    if (seen.has(image.url)) continue;
    seen.add(image.url);
    unique.push(image);
  }
  const visible = unique.slice(0, Math.max(0, max));
  return { visible, extraCount: Math.max(0, unique.length - visible.length) };
}

/** Extract KPI and Claude artifact badges from item/task text and title. */
export function extractArtifactBadges(input: { text?: string; title?: string }): ArtifactBadge[] {
  const text = input.text ?? "";
  const title = input.title ?? "";
  const combined = `${title}\n${text}`;
  const mentionsKpi = /\bkpi\b/i.test(combined);
  const badges: ArtifactBadge[] = [];
  const seen = new Set<string>();

  const pushBadge = (badge: ArtifactBadge) => {
    const key = `${badge.kind}|${badge.label}|${badge.url ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    badges.push(badge);
  };

  const urlRe = new RegExp(CLAUDE_ARTIFACT_URL_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = urlRe.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:!?)\]}]+$/, "");
    if (!url) continue;
    pushBadge({
      kind: mentionsKpi ? "kpi" : "artifact",
      label: mentionsKpi ? "KPI artifact" : "Claude artifact",
      url,
    });
  }

  if (badges.length === 0 && (/Create a Claude artifact.*KPIs/i.test(text) || /\bKPI\b.*\bartifact\b/i.test(combined))) {
    const label = /Format:\s*Slides:/i.test(text)
      ? "KPI · Slides"
      : /Format:\s*One page:/i.test(text)
        ? "KPI · One pager"
        : "KPI artifact";
    pushBadge({ kind: "kpi", label });
  }

  return badges;
}
