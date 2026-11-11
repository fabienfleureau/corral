import type { Context, Favorite, Repo } from "./types.ts";

export const CONTEXTS: readonly Context[] = ["professional", "personal"];

/** The context of the task's repo; null when the task has no registered repo yet. */
export function repoContext(repos: Pick<Repo, "path" | "context">[], path: string): Context | null {
  const repo = path ? repos.find((r) => r.path === path) : undefined;
  return repo ? repo.context ?? "professional" : null;
}

/** Favorites matching the context; all of them when the context is unknown. */
export function favoritesFor<F extends Pick<Favorite, "context">>(favorites: F[], context: Context | null): F[] {
  if (!context) return favorites;
  return favorites.filter((f) => (f.context ?? "professional") === context);
}
