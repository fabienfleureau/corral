import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { groupTasks, sortRepos } from '../../web/src/task-page.ts';

test('groups by repo and orders tasks by status then recency', () => {
  const tasks = [
    { id: 'done', repo_path: '/a', status: 'done', created_ms: 4 },
    { id: 'open', repo_path: '/a', status: 'open', created_ms: 1 },
    { id: 'other', repo_path: '', status: 'open', created_ms: 3 },
    { id: 'active', repo_path: '/a', status: 'dispatched', created_ms: 2 },
  ] as any;
  const groups = groupTasks(tasks);
  assert.deepEqual(groups.map(([path, rows]) => [path, rows.map((t) => t.id)]), [['/a', ['open', 'active', 'done']], ['', ['other']]]);
});

test('sorts repos by most recent task creation, with unused repos last', () => {
  const repos = [{ path: '/a', name: 'A' }, { path: '/b', name: 'B' }, { path: '/c', name: 'C' }] as any;
  const tasks = [{ repo_path: '/a', created_ms: 1 }, { repo_path: '/b', created_ms: 3 }] as any;
  assert.deepEqual(sortRepos(repos, tasks).map((r) => r.name), ['B', 'A', 'C']);
});
