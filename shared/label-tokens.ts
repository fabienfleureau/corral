// Label normalization shared by the server (probable repeats, retries) and
// the task form (repo mismatch warning): one tokenizer, so a label means the
// same thing on both sides. Pure: no Node or DOM APIs.

// English and French: prompts are written in both. Conventional-commit types
// are noise too: a done title "fix(kpi): ..." must match a prompt without it.
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "from", "by", "with", "without",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "as", "into", "when",
  "not", "no", "do", "does", "should", "must", "can", "still", "after", "before", "so", "we", "i", "you", "our", "my",
  "le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "et", "ou", "en", "dans", "sur", "pour", "par", "avec",
  "sans", "au", "aux", "ce", "cet", "cette", "ces", "est", "sont", "pas", "ne", "plus", "qui", "que", "qu", "il", "elle",
  "ils", "on", "se", "s", "y", "je", "nous", "vous", "mon", "ma", "mes", "son", "sa", "ses", "quand", "apres", "avant",
  "fix", "feat", "chore", "refactor", "docs", "style", "perf",
]);

/** Normalized tokens of a label: lowercase, accents and punctuation stripped,
 *  Jira keys and stop words dropped, a trailing plural "s" removed. */
export function labelTokens(text: string): Set<string> {
  const tokens = text
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
  return new Set(tokens);
}

/** One string per label: equal keys mean the same label once case,
 *  punctuation, accents and stop words are ignored. */
export function labelKey(text: string): string {
  return [...labelTokens(text)].sort().join(" ");
}
