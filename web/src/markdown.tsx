// Small, safe Markdown renderer. Builds React elements only — never HTML
// strings — so agent-supplied content cannot inject markup or scripts.
// Supported: headings, paragraphs (hard breaks), fenced code, inline code,
// bold / italic / strikethrough, links (http/https/mailto only), ordered and
// unordered lists, blockquotes, pipe tables, horizontal rules.

import type { ReactNode } from "react";

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s<>"']+)/g;

function inline(text: string, keyBase = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  // Fresh regex per call: inline() recurses on emphasis tokens, and a shared
  // /g regex would have its lastIndex clobbered by the inner call — the outer
  // loop then re-matches the same token forever.
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith("`")) {
      nodes.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      nodes.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    } else if (tok.startsWith("~~")) {
      nodes.push(<del key={key}>{tok.slice(2, -2)}</del>);
    } else if (tok.startsWith("[")) {
      const lm = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok);
      const url = lm ? lm[2] : "";
      const label = lm ? lm[1] || url : tok;
      const safe = /^(https?:\/\/|mailto:)/i.test(url);
      nodes.push(
        safe ? (
          <a key={key} href={url} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else if (tok.startsWith("http")) {
      // Bare URL, autolinked. Trailing punctuation stays outside the link.
      const trailing = /[.,;:!?)\]}]+$/.exec(tok);
      const url = trailing ? tok.slice(0, tok.length - trailing[0].length) : tok;
      nodes.push(
        <a key={key} href={url} target="_blank" rel="noreferrer">
          {url}
        </a>,
      );
      if (trailing) nodes.push(trailing[0]);
    } else {
      nodes.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { type: "code"; lang: string; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "hr" }
  | { type: "quote"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[][] }
  | { type: "table"; header: string[]; align: ("left" | "center" | "right" | null)[]; rows: string[][] }
  | { type: "para"; lines: string[] };

const HR_RE = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^ {0,3}(```+|~~~+)\s*(\S*)\s*$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1][0] === "`" ? "```" : "~~~";
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or run off the end)
      blocks.push({ type: "code", lang: fence[2], lines: code });
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && (QUOTE_RE.test(lines[i]) || (lines[i].trim() && quote.length > 0 && !HEADING_RE.test(lines[i]) && !FENCE_RE.test(lines[i])))) {
        const qm = QUOTE_RE.exec(lines[i]);
        quote.push(qm ? qm[1] : lines[i]);
        i++;
      }
      blocks.push({ type: "quote", lines: quote });
      continue;
    }

    // pipe table: a row containing | followed by a separator row
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : null;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const items: string[][] = [];
      while (i < lines.length) {
        const lm = LIST_RE.exec(lines[i]);
        if (lm) {
          items.push([lm[3]]);
          i++;
        } else if (lines[i].trim() && items.length > 0 && /^\s{2,}/.test(lines[i])) {
          items[items.length - 1].push(lines[i].trim()); // continuation line
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // paragraph: consecutive plain lines, hard breaks between them
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "para", lines: para });
  }

  return blocks;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={className ? `md ${className}` : "md"}>
      {blocks.map((block, bi) => {
        const key = `b${bi}`;
        switch (block.type) {
          case "code":
            return (
              <pre key={key} className="md-code">
                <code>{block.lines.join("\n")}</code>
              </pre>
            );
          case "heading": {
            const Tag = (`h${Math.min(block.level + 1, 6)}`) as "h2" | "h3" | "h4" | "h5" | "h6";
            return <Tag key={key}>{inline(block.text, key)}</Tag>;
          }
          case "hr":
            return <hr key={key} />;
          case "quote":
            return (
              <blockquote key={key}>
                <Markdown text={block.lines.join("\n")} />
              </blockquote>
            );
          case "list": {
            const items = block.items.map((item, ii) => (
              <li key={`${key}-${ii}`}>
                {item.map((line, li) => (
                  <span key={li}>
                    {li > 0 ? <br /> : null}
                    {inline(line, `${key}-${ii}-${li}`)}
                  </span>
                ))}
              </li>
            ));
            return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case "table":
            return (
              <table key={key}>
                <thead>
                  <tr>
                    {block.header.map((h, hi) => (
                      <th key={hi} style={{ textAlign: block.align[hi] ?? undefined }}>
                        {inline(h, `${key}-h${hi}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} style={{ textAlign: block.align[ci] ?? undefined }}>
                          {inline(cell, `${key}-${ri}-${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          case "para":
            return (
              <p key={key}>
                {block.lines.map((line, li) => (
                  <span key={li}>
                    {li > 0 ? <br /> : null}
                    {inline(line, `${key}-${li}`)}
                  </span>
                ))}
              </p>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
