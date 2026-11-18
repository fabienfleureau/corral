import type { Question } from './question-reply.ts';

export interface GrillQuestion extends Question { recommendation: string }

export function parseGrillRound(text: string): GrillQuestion[] {
  const matches = [...text.matchAll(/(?:^|\n)\s*❓\s*(?:\*\*)?(Q\d+)(?:\*\*)?\s*[-–:]/gi)];
  return matches.map((match, index) => {
    const body = text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length).replace(/\n\s*---\s*$/, '').trim();
    const [question, ...recommendation] = body.split(/➡️?/);
    const lines = question.split('\n');
    const choices = lines.filter((line) => /^\s*(?:[-*]\s*)?\([a-z]\)\s+/i.test(line)).map((line) => line.trim().replace(/^[-*]\s*/, ''));
    const prompt = lines.filter((line) => !/^\s*(?:[-*]\s*)?\([a-z]\)\s+/i.test(line)).join('\n').trim();
    return { id: match[1].toUpperCase(), prompt, choices, multiple: /\b(?:one or more|multiple|select all|choose all)\b/i.test(prompt), recommendation: recommendation.join('➡️').trim() };
  }).filter((q) => q.prompt);
}

export function formatGrillAnswers(questions: GrillQuestion[], answers: Record<string, string | string[]>): string {
  return questions.map((q) => `${q.id}: ${Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).join('; ') : answers[q.id]}`).join('\n');
}
