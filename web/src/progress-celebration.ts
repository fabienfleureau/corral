export type ProgressCounts = { level: number; tasks: number; inbox: number };
export const thresholds = [1, 10, 50] as const;
export function achievements(previous: ProgressCounts, current: ProgressCounts): string[] {
  const result: string[] = [];
  if (current.level > previous.level) result.push(`Level ${current.level} reached`);
  for (const [key, name] of [['tasks', 'Tasks created'], ['inbox', 'Inbox handled']] as const) {
    for (const threshold of thresholds) if (previous[key] < threshold && current[key] >= threshold) result.push(`${name} · ${threshold}`);
  }
  return result;
}
