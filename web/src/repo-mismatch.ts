// Warn before dispatching a code task whose prompt targets another registered
// repo: tasks were dispatched in the wrong repo, the agent asked what a term
// meant there, and the task was archived and recreated in the right one.
// Cheap and deterministic: repo names and the words of each repo's past task
// labels, no LLM. A warning only; the human decides.

import { labelTokens } from "../../shared/label-tokens.ts";

export interface MismatchRepo { path: string; name: string }
export interface MismatchTask { repo_path: string; title: string; prompt: string; status?: string }

export interface RepoMismatch {
  path: string;
  name: string;
  /** `named`: the prompt names that repo. `terms`: its words belong to that repo's past tasks. */
  reason: "named" | "terms";
  /** The prompt words only that repo's past tasks use (reason `terms`). */
  terms: string[];
}

/** Words only one repo's tasks use count as evidence; this many are needed. */
const MIN_TERMS = 2;

function names(repo: MismatchRepo): string[] {
  const base = repo.path.split("/").filter(Boolean).pop() ?? "";
  return [...new Set([repo.name, base].map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 3))];
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`).test(text);
}

function vocabulary(task: MismatchTask): Set<string> {
  return labelTokens(`${task.title}\n${task.prompt.trim().split("\n")[0] ?? ""}`);
}

/** Another registered repo the prompt clearly targets, or null. */
export function repoMismatch(prompt: string, selectedPath: string, repos: MismatchRepo[], tasks: MismatchTask[]): RepoMismatch | null {
  const text = prompt.toLowerCase();
  const selected = repos.find((r) => r.path === selectedPath);
  if (!text.trim() || !selected) return null;
  const others = repos.filter((r) => r.path !== selectedPath);

  // 1. The prompt names exactly one other repo and not the selected one.
  if (!names(selected).some((n) => mentions(text, n))) {
    const named = others.filter((r) => names(r).some((n) => mentions(text, n)));
    if (named.length === 1) return { path: named[0].path, name: named[0].name, reason: "named", terms: [] };
  }

  // 2. Its words belong to one other repo's past tasks, and to none of the selected repo's.
  const vocab = new Map<string, Set<string>>();
  for (const task of tasks) {
    // An archived task was abandoned, often because it ran in the wrong repo:
    // its words would credit that repo and silence the next warning.
    if (task.status === "archived" || !repos.some((r) => r.path === task.repo_path)) continue;
    const words = vocab.get(task.repo_path) ?? new Set<string>();
    for (const w of vocabulary(task)) words.add(w);
    vocab.set(task.repo_path, words);
  }
  const owners = new Map<string, string[]>();
  for (const word of labelTokens(prompt)) {
    const holders = [...vocab.entries()].filter(([, words]) => words.has(word)).map(([path]) => path);
    if (holders.length === 1) owners.set(holders[0], [...(owners.get(holders[0]) ?? []), word]);
  }
  if ((owners.get(selectedPath)?.length ?? 0) > 0) return null;
  const ranked = others
    .map((r) => ({ repo: r, terms: owners.get(r.path) ?? [] }))
    .filter((r) => r.terms.length >= MIN_TERMS)
    .sort((a, b) => b.terms.length - a.terms.length);
  if (ranked.length === 0 || (ranked[1] && ranked[1].terms.length === ranked[0].terms.length)) return null;
  return { path: ranked[0].repo.path, name: ranked[0].repo.name, reason: "terms", terms: ranked[0].terms.sort() };
}
