import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { filterTasks, groupTasks, lastSpecFolder, sortRepos } from '../../web/src/task-page.ts';

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

test('uses the latest settings for each harness, including cleared settings', async () => {
  const { lastHarnessSettings } = await import('../../web/src/task-page.ts');
  const tasks = [
    { target: 'codex', model: 'old', reasoning: 'low', created_ms: 1 },
    { target: 'claude', model: 'opus', reasoning: null, created_ms: 3 },
    { target: 'codex', model: null, reasoning: 'high', created_ms: 2 },
  ] as any;
  assert.deepEqual(lastHarnessSettings(tasks, 'codex'), { model: '', reasoning: 'high' });
  assert.deepEqual(lastHarnessSettings(tasks, 'claude'), { model: 'opus', reasoning: '' });
  assert.deepEqual(lastHarnessSettings(tasks, 'other'), { model: '', reasoning: '' });
});

test('prefills the spec folder from the newest spec task only', () => {
  const tasks = [
    { kind: 'spec', repo_path: ' /old/folder ', created_ms: 1 },
    { kind: 'code', repo_path: '/newer/repo', created_ms: 5 },
    { kind: 'spec', repo_path: '/new/folder', created_ms: 3 },
    { kind: 'spec', repo_path: '', created_ms: 4 },
  ] as any;
  assert.equal(lastSpecFolder(tasks), '/new/folder');
  assert.equal(lastSpecFolder([]), '');
});

test('model options retain saved values and use model-specific reasoning', async () => {
  const { modelChoices, reasoningChoices } = await import('../../web/src/task-page.ts');
  const models = [{ id: 'one', label: 'One', reasoning: ['low', 'high'] }, { id: 'two', label: 'Two', reasoning: ['medium'] }];
  assert.deepEqual(modelChoices(models, 'legacy').map((m) => m.id), ['legacy', 'one', 'two']);
  assert.deepEqual(reasoningChoices(models, 'one', 'old'), ['old', 'low', 'high']);
  assert.deepEqual(reasoningChoices(models, 'two', ''), ['medium']);
});

test('filters done and archived tasks unless opted in', () => {
  const tasks = [
    { id: 'open', status: 'open' },
    { id: 'dispatched', status: 'dispatched' },
    { id: 'done', status: 'done' },
    { id: 'archived', status: 'archived' },
  ] as any;
  assert.deepEqual(filterTasks(tasks, false).map((t: any) => t.id), ['open', 'dispatched']);
  assert.deepEqual(filterTasks(tasks, true).map((t: any) => t.id), ['open', 'dispatched', 'done', 'archived']);
});
