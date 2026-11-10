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
