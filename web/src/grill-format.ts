import type { Question } from './question-reply.ts';

export interface GrillQuestion extends Question { recommendation: string }

// Match numbered ❓ questions across common agent formats:
// `❓ **Q1** - ...`, `❓ **Q1:** ...`, `❓ Q1 — ...`, `❓ **1. ...**`, `❓ **5/5. ...**`, `### ❓ Q1: ...`.
const HEADER = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+|[-*][ \t]+)?(?<open1>\*\*[ \t]*)?❓[ \t]*(?<open2>\*\*[ \t]*)?(?<id>Q\d+|\d+(?:[ \t]*\/[ \t]*\d+)?)(?:(?<close1>\*\*)[ \t]*[-–—:.)]|[ \t]*[-–—:.)](?<close2>\*\*)?)/gi;

// Agents write choices as (a), A., 1., their dash/bullet variants, and bolded labels like `- **A. ...**`.
const CHOICE = /^\s*(?:[-*]\s*)?(?:(?:\*\*\s*)?(?:\([a-z0-9]+\)|[a-z0-9]{1,2}[.)])(?:\s*\*\*)?|\*\*\s*[a-z]\s*\*\*\s*[-–—:])\s+\S/i;

function normalizeId(raw: string): string {
  const compact = raw.replace(/\s+/g, '');
  if (/^q\d+$/i.test(compact)) return compact.toUpperCase();
  return `Q${compact.split('/')[0]}`;
}

function restoreUnclosedBold(body: string): string {
  const nl = body.indexOf('\n');
  const first = nl === -1 ? body : body.slice(0, nl);
  const rest = nl === -1 ? '' : body.slice(nl);
  if (!first.includes('**')) return body;
  return `**${first.trimStart()}${rest}`;
}

function stripBold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1');
}

export function parseGrillRound(text: string): GrillQuestion[] {
  const matches = [...text.matchAll(HEADER)];
  const seen = new Map<string, number>();
  return matches.map((match, index) => {
    const groups = match.groups ?? {};
    const unclosedBold = Boolean(groups.open1 || groups.open2) && !groups.close1 && !groups.close2;
    let body = text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length).replace(/\n\s*---\s*$/, '').trim();
    if (unclosedBold) body = restoreUnclosedBold(body);
    const [question, ...rawRecommendation] = body.split(/➡️?/);
    const lines = question.split('\n');
    const choices = lines
      .filter((line) => CHOICE.test(line))
      .map((line) => stripBold(line.trim().replace(/^[-*]\s*/, '')).trim());
    const prompt = lines.filter((line) => !CHOICE.test(line)).join('\n').trim();
    const recommendation = stripBold(
      rawRecommendation
        .join('➡️')
        .trim()
        .replace(/^(?:\*\*\s*)?(?:recommendation|recommandation)\s*:?(?:\s*\*\*)?\s*:?\s*/i, ''),
    ).trim();
    const baseId = normalizeId(groups.id ?? String(index + 1));
    const count = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, count);
    const id = count === 1 ? baseId : `${baseId}-${count}`;
    return { id, prompt, choices, multiple: /\b(?:one or more|multiple|select all|choose all|plusieurs choix)\b/i.test(prompt), recommendation };
  }).filter((q) => q.prompt);
}

export function formatGrillAnswers(questions: GrillQuestion[], answers: Record<string, string | string[]>): string {
  return questions.map((q) => `${q.id}: ${Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).join('; ') : answers[q.id]}`).join('\n');
}
