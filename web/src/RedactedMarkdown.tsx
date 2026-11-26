// Copy or save the redacted Markdown built by redacted-export.ts. The text is
// generated here, not read from the DOM, so it is passed in directly; feedback
// stays outside the button so a screen reader announces the same result a
// sighted user sees.

import { useEffect, useRef, useState } from "react";

function exportName(basename: string): string {
  const safe = basename.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${safe || "corral-report"}.md`;
}

export function RedactedMarkdownButtons({ markdown, basename }: { markdown: string; basename: string }) {
  const [status, setStatus] = useState("");
  const lastStatus = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const report = (message: string) => {
    // VoiceOver skips a repeated message from the same live region.
    const text = message === lastStatus.current ? `${message}\u00A0` : message;
    lastStatus.current = text;
    setStatus(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(""), 2500);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      report("Copied");
    } catch {
      report("Copy failed");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = exportName(basename);
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    report("Saved");
  };

  return (
    <span className="redacted-export">
      <button type="button" className="btn" onClick={() => void copy()} title="Copy redacted Markdown for Slack, Jira or GitHub">
        Copy Markdown
      </button>
      <button type="button" className="btn" onClick={download} title="Download the same redacted Markdown as a .md file">
        Download .md
      </button>
      <span className="redacted-export-status" role="status">{status}</span>
    </span>
  );
}
