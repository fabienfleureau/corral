import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combineRowImages,
  extractArtifactBadges,
  extractMarkdownImages,
  isSafePreviewImageUrl,
  taskAttachmentPreviews,
} from "../../web/src/row-previews.ts";

test("isSafePreviewImageUrl accepts http(s) and task attachment routes, rejects unsafe schemes", () => {
  assert.equal(isSafePreviewImageUrl("https://example.com/a.png"), true);
  assert.equal(isSafePreviewImageUrl("http://127.0.0.1:4787/shot.jpg"), true);
  assert.equal(isSafePreviewImageUrl("/api/tasks/task-1/attachments/att-1"), true);
  assert.equal(isSafePreviewImageUrl("javascript:alert(1)"), false);
  assert.equal(isSafePreviewImageUrl("data:image/png;base64,AAA"), false);
  assert.equal(isSafePreviewImageUrl("file:///etc/passwd"), false);
  assert.equal(isSafePreviewImageUrl("/etc/passwd"), false);
});

test("extractMarkdownImages parses markdown and html img tags, deduplicates, and caps", () => {
  const text = [
    "![First](https://example.com/one.png)",
    "![Unsafe](javascript:alert(1))",
    "![Dup](https://example.com/one.png)",
    "![](https://example.com/two.webp)",
    "![Fourth](https://example.com/four.png)",
  ].join("\n");
  assert.deepEqual(extractMarkdownImages(text, 2), [
    { url: "https://example.com/one.png", alt: "First", source: "markdown" },
    { url: "https://example.com/two.webp", alt: "Preview image", source: "markdown" },
  ]);

  const htmlText = [
    '<img src="/api/tasks/t1/attachments/a1" alt="Attached shot" />',
    '<img src="javascript:alert(1)" alt="Bad" />',
  ].join("\n");
  assert.deepEqual(extractMarkdownImages(htmlText, 3), [
    { url: "/api/tasks/t1/attachments/a1", alt: "Attached shot", source: "markdown" },
  ]);
});

test("taskAttachmentPreviews and combineRowImages prioritize attachments and report extraCount", () => {
  const attachments = taskAttachmentPreviews("task/1", [
    { id: "a1", filename: "shot.png", content_type: "image/png" },
    { id: "a2", filename: "diff.png", content_type: "image/png" },
  ]);
  const markdown = extractMarkdownImages([
    "![Dup](/api/tasks/task%2F1/attachments/a1)",
    "![Three](https://example.com/3.png)",
    "![Four](https://example.com/4.png)",
  ].join("\n"));
  const combined = combineRowImages(attachments, markdown, 3);
  assert.equal(combined.visible.length, 3);
  assert.equal(combined.extraCount, 1);
  assert.equal(combined.visible[0].source, "attachment");
});

test("extractArtifactBadges detects Claude artifact URLs and KPI artifact prompts", () => {
  assert.deepEqual(
    extractArtifactBadges({
      title: "Agent stopped without reporting",
      text: "Review the [Weekly KPI artifact](https://claude.ai/public/artifacts/kpi-123).",
    }),
    [{ kind: "kpi", label: "KPI artifact", url: "https://claude.ai/public/artifacts/kpi-123" }],
  );

  assert.deepEqual(
    extractArtifactBadges({
      title: "Build artifact",
      text: "See https://claude.ai/artifacts/abc-456 for details",
    }),
    [{ kind: "artifact", label: "Claude artifact", url: "https://claude.ai/artifacts/abc-456" }],
  );

  assert.deepEqual(
    extractArtifactBadges({
      title: "Weekly active reporters",
      text: "Create a Claude artifact that gives the team a factual status update on the configured KPIs.\n\nFormat: Slides: 6 to 10 slides.",
    }),
    [{ kind: "kpi", label: "KPI · Slides" }],
  );
});
