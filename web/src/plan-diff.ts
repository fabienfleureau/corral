// Dependency-free line-and-word Markdown diff engine for multi-repo plans.
// Pure module: Node loads it directly from server/test/ without a browser.

export type DiffWordSpan = {
  text: string;
  changed: boolean;
};

export type DiffLine = {
  type: "context" | "add" | "remove";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  spans?: DiffWordSpan[];
};

export type DiffSegment =
  | { kind: "line"; line: DiffLine }
  | { kind: "collapsed"; lines: DiffLine[] };

export type PlanDiffResult = {
  identical: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
  segments: DiffSegment[];
};

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized === "" ? [] : normalized.split("\n");
}

/** Longest-common-subsequence edit script over two arrays of strings. */
function lcsDiff(a: string[], b: string[]): { type: "context" | "add" | "remove"; text: string }[] {
  const n = a.length;
  const m = b.length;
  // Trim common prefix and suffix to keep the DP table small on long plans.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const midA = a.slice(prefix, n - suffix);
  const midB = b.slice(prefix, m - suffix);
  const an = midA.length;
  const bm = midB.length;

  const out: { type: "context" | "add" | "remove"; text: string }[] = [];
  for (let i = 0; i < prefix; i++) out.push({ type: "context", text: a[i] });

  if (an === 0) {
    for (let j = 0; j < bm; j++) out.push({ type: "add", text: midB[j] });
  } else if (bm === 0) {
    for (let i = 0; i < an; i++) out.push({ type: "remove", text: midA[i] });
  } else {
    // Standard LCS length table (flat Int32Array for memory efficiency).
    const stride = bm + 1;
    const dp = new Int32Array((an + 1) * stride);
    for (let i = an - 1; i >= 0; i--) {
      const row = i * stride;
      const nextRow = (i + 1) * stride;
      for (let j = bm - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[row + j] = dp[nextRow + j + 1] + 1;
        } else {
          const down = dp[nextRow + j];
          const right = dp[row + j + 1];
          dp[row + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < an && j < bm) {
      if (midA[i] === midB[j]) {
        out.push({ type: "context", text: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
        out.push({ type: "remove", text: midA[i] });
        i++;
      } else {
        out.push({ type: "add", text: midB[j] });
        j++;
      }
    }
    while (i < an) {
      out.push({ type: "remove", text: midA[i++] });
    }
    while (j < bm) {
      out.push({ type: "add", text: midB[j++] });
    }
  }

  for (let k = suffix - 1; k >= 0; k--) {
    out.push({ type: "context", text: a[n - 1 - k] });
  }
  return out;
}

/** Tokenize a line into words, whitespace, and punctuation for inline highlights. */
function tokenizeWords(line: string): string[] {
  return line.match(/\s+|\w+|[^\s\w]+/g) ?? [];
}

function mergeSpans(raw: DiffWordSpan[]): DiffWordSpan[] {
  const merged: DiffWordSpan[] = [];
  for (const span of raw) {
    if (!span.text) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.changed === span.changed) prev.text += span.text;
    else merged.push({ ...span });
  }
  return merged;
}

/** Compute inline word-level highlight spans for a paired removed/added line. */
export function diffLineWords(oldText: string, newText: string): { oldSpans: DiffWordSpan[]; newSpans: DiffWordSpan[] } {
  const oldTokens = tokenizeWords(oldText);
  const newTokens = tokenizeWords(newText);
  const ops = lcsDiff(oldTokens, newTokens);
  const oldSpans: DiffWordSpan[] = [];
  const newSpans: DiffWordSpan[] = [];
  for (const op of ops) {
    if (op.type === "context") {
      oldSpans.push({ text: op.text, changed: false });
      newSpans.push({ text: op.text, changed: false });
    } else if (op.type === "remove") {
      oldSpans.push({ text: op.text, changed: true });
    } else {
      newSpans.push({ text: op.text, changed: true });
    }
  }
  return { oldSpans: mergeSpans(oldSpans), newSpans: mergeSpans(newSpans) };
}

/** Collapse long unchanged runs while keeping `contextLines` around every change. */
function collapseContext(lines: DiffLine[], contextLines: number): DiffSegment[] {
  if (lines.length === 0) return [];
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "context") {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      for (let k = start; k <= end; k++) keep[k] = 1;
    }
  }
  const segments: DiffSegment[] = [];
  let i = 0;
  while (i < lines.length) {
    if (keep[i]) {
      segments.push({ kind: "line", line: lines[i] });
      i++;
    } else {
      const start = i;
      while (i < lines.length && !keep[i]) i++;
      const run = lines.slice(start, i);
      // Only collapse runs of at least 4 lines; shorter runs are cheaper to show inline.
      if (run.length >= 4) {
        segments.push({ kind: "collapsed", lines: run });
      } else {
        for (const line of run) segments.push({ kind: "line", line });
      }
    }
  }
  return segments;
}

/**
 * Diff two canonical Markdown strings line-by-line, with inline word-diff spans
 * on paired removed/added lines and collapsed unchanged runs.
 */
export function diffMarkdown(baseMarkdown: string, targetMarkdown: string, contextLines = 3): PlanDiffResult {
  const oldLines = splitLines(baseMarkdown);
  const newLines = splitLines(targetMarkdown);
  const rawOps = lcsDiff(oldLines, newLines);

  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;
  const lines: DiffLine[] = rawOps.map((op) => {
    if (op.type === "context") {
      return { type: "context", text: op.text, oldLine: oldNo++, newLine: newNo++ };
    }
    if (op.type === "remove") {
      removed++;
      return { type: "remove", text: op.text, oldLine: oldNo++, newLine: null };
    }
    added++;
    return { type: "add", text: op.text, oldLine: null, newLine: newNo++ };
  });

  // Inline word-level pass for paired removed/added hunks (up to 8 lines per side).
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "remove") {
      i++;
      continue;
    }
    const remStart = i;
    while (i < lines.length && lines[i].type === "remove") i++;
    const addStart = i;
    while (i < lines.length && lines[i].type === "add") i++;
    const remCount = addStart - remStart;
    const addCount = i - addStart;
    if (remCount > 0 && addCount > 0 && Math.max(remCount, addCount) <= 8) {
      const pairs = Math.min(remCount, addCount);
      for (let p = 0; p < pairs; p++) {
        const { oldSpans, newSpans } = diffLineWords(lines[remStart + p].text, lines[addStart + p].text);
        lines[remStart + p].spans = oldSpans;
        lines[addStart + p].spans = newSpans;
      }
    }
  }

  const identical = added === 0 && removed === 0;
  return {
    identical,
    added,
    removed,
    lines,
    segments: identical ? [] : collapseContext(lines, contextLines),
  };
}
