import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Db } from '../db.ts';

test('rewards are distinct and levels take progressively more XP', () => {
  const db = new Db(':memory:');
  assert.deepEqual(db.progression(), { xp: 0, level: 1, levelXp: 0, nextLevelXp: 100, tasks: 0, inbox: 0 });
  for (let i = 0; i < 10; i++) db.reward('task', String(i));
  db.reward('task', '0');
  assert.deepEqual(db.progression(), { xp: 100, level: 2, levelXp: 0, nextLevelXp: 200, tasks: 10, inbox: 0 });
  for (let i = 0; i < 10; i++) db.reward('inbox', String(i));
  assert.deepEqual(db.progression(), { xp: 300, level: 3, levelXp: 0, nextLevelXp: 300, tasks: 10, inbox: 10 });
  db.raw.close();
});

test('only successful manual API actions earn rewards', async () => {
  const { createHttpServer } = await import('../api.ts');
  const db = new Db(':memory:');
  db.raw.exec("INSERT INTO items (id, kind, title, created_ms, updated_ms) VALUES ('old', 'question', 'Old', 0, 0), ('automatic', 'done', 'Automatic', 0, 0)");
  const server = createHttpServer({ db, cfg: { token: 'test' }, hub: { broadcast() {}, clients: new Set() }, backend: { send: async () => { throw new Error('offline'); } } } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: object = {}) => fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/tasks', {})).status, 400);
    assert.equal((await post('/api/items/missing/resolve')).status, 404);
    assert.equal((await post('/api/items/old/reply', { text: 'hello' })).status, 409);
    db.updateItem('automatic', { status: 'resolved', resolved_ms: Date.now() });
    assert.equal(db.progression().xp, 0);
    assert.equal((await post('/api/tasks', { title: 'New task' })).status, 200);
    assert.equal((await post('/api/items/old/resolve')).status, 200);
    assert.equal((await post('/api/items/old/resolve')).status, 200);
    assert.equal(db.progression().xp, 30);
    const response = await fetch(base + '/api/progression', { headers: { Authorization: 'Bearer test' } });
    assert.deepEqual(await response.json(), db.progression());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
