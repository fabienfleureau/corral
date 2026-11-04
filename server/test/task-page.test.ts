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

test('orders repository groups by latest task creation', () => {
  const tasks = [
    { id: 'a', repo_path: '/a', status: 'open', created_ms: 1 },
    { id: 'b', repo_path: '/b', status: 'open', created_ms: 3 },
  ] as any;
  assert.deepEqual(groupTasks(tasks).map(([path]) => path), ['/b', '/a']);
});

test('harness labels show known quota windows and flag stale snapshots', async () => {
  const { harnessLabel } = await import('../../web/src/task-page.ts');
  const quota = [{ agent: 'codex', plan: 'Plus', stale: true, windows: [{ label: '5-hour', used_percent: 42.4 }, { label: 'Weekly', used_percent: 80 }] }] as any;
  assert.equal(harnessLabel('codex', quota), 'codex — Plus · 5-hour 42% used · Weekly 80% used · stale');
  assert.equal(harnessLabel('claude', quota), 'claude');
  assert.equal(harnessLabel('codex', [{ ...quota[0], windows: [] }]), 'codex');
});
