import type { Repo, Task } from './types.ts';

const statusOrder: Record<Task['status'], number> = { open: 0, dispatched: 1, done: 2, archived: 3 };

export function groupTasks(tasks: Task[]): [string, Task[]][] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.repo_path || '';
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return [...groups.entries()]
    .sort(([a, ar], [b, br]) => Math.max(...br.map(t => t.created_ms)) - Math.max(...ar.map(t => t.created_ms)) || a.localeCompare(b))
    .map(([key, rows]) => [key, rows.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || b.created_ms - a.created_ms)]);
}

export function sortRepos(repos: Repo[], tasks: Task[]): Repo[] {
  const lastUsed = new Map<string, number>();
  for (const task of tasks) lastUsed.set(task.repo_path, Math.max(lastUsed.get(task.repo_path) ?? 0, task.created_ms));
  return [...repos].sort((a, b) => (lastUsed.get(b.path) ?? 0) - (lastUsed.get(a.path) ?? 0) || a.name.localeCompare(b.name));
}
