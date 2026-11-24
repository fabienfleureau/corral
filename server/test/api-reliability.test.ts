import { test } from 'node:test';
import assert from 'node:assert/strict';

const { withDeadline } = await import('../../server/deadline.ts');
const { cacheControlFor, etagFor, isFresh } = await import('../../server/static-cache.ts');

test('withDeadline returns the value when the work answers in time', async () => {
  const value = await withDeadline(Promise.resolve('backend'), 1000, 'fallback');
  assert.equal(value, 'backend');
});

test('withDeadline serves the fallback instead of hanging on a stalled dependency', async () => {
  const pending = new Promise<string>(() => undefined);
  const started = Date.now();
  const value = await withDeadline(pending, 20, 'fallback');
  assert.equal(value, 'fallback');
  assert.ok(Date.now() - started < 1000);
});

test('withDeadline keeps a rejection visible to the caller', async () => {
  await assert.rejects(() => withDeadline(Promise.reject(new Error('backend down')), 1000, 'fallback'), /backend down/);
});

test('withDeadline without a budget awaits the work as-is', async () => {
  const value = await withDeadline(Promise.resolve('backend'), 0, 'fallback');
  assert.equal(value, 'backend');
});

test('hashed bundles are immutable, the shell and worker are revalidated', () => {
  assert.equal(cacheControlFor('/assets/index-4f9a.js'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('/assets/index-4f9a.css'), 'public, max-age=31536000, immutable');
  assert.equal(cacheControlFor('/'), 'no-cache');
  assert.equal(cacheControlFor('/tasks'), 'no-cache');
  assert.equal(cacheControlFor('/sw.js'), 'no-cache');
});

test('a client revalidating an unchanged file gets a match', () => {
  const etag = etagFor(1234, 1_700_000_000_123);
  assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  assert.equal(isFresh(etag, etag), true);
  assert.equal(isFresh(etag.replace('W/', ''), etag), true);
  assert.equal(isFresh(`"other", ${etag}`, etag), true);
  assert.equal(isFresh('W/"different"', etag), false);
  assert.equal(isFresh(undefined, etag), false);
});

test('an unknown API path answers JSON 404 instead of the SPA shell', async () => {
  const { createHttpServer } = await import('../../server/api.ts');
  const { Db } = await import('../../server/db.ts');
  const db = new Db(':memory:');
  const server = createHttpServer({ db, cfg: { token: 'test' }, hub: { broadcast() {}, clients: new Set() } } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`, { headers: { Authorization: 'Bearer test' } });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? '', /unknown endpoint.*\/api\/does-not-exist/);
    const put = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`, { method: 'PUT', headers: { Authorization: 'Bearer test' }, body: '{}' });
    assert.equal(put.status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('a page path still falls back to the SPA shell', async (t) => {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  if (!existsSync(join(process.cwd(), 'web', 'dist', 'index.html'))) {
    t.skip('web/dist not built');
    return;
  }
  const { createHttpServer } = await import('../../server/api.ts');
  const { Db } = await import('../../server/db.ts');
  const db = new Db(':memory:');
  const server = createHttpServer({ db, cfg: { token: 'test' }, hub: { broadcast() {}, clients: new Set() } } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/tasks`, { headers: { Authorization: 'Bearer test' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

test('a missing /assets/ file returns 404 instead of the SPA shell', async (t) => {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  if (!existsSync(join(process.cwd(), 'web', 'dist', 'index.html'))) {
    t.skip('web/dist not built');
    return;
  }
  const { createHttpServer } = await import('../../server/api.ts');
  const { Db } = await import('../../server/db.ts');
  const db = new Db(':memory:');
  const server = createHttpServer({ db, cfg: { token: 'test' }, hub: { broadcast() {}, clients: new Set() } } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/assets/nonexistent-chunk.js`, { headers: { Authorization: 'Bearer test' } });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.doesNotMatch(response.headers.get('cache-control') ?? '', /immutable/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
