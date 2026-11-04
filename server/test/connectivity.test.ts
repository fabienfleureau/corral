import { test } from 'node:test';
import assert from 'node:assert/strict';
const clientPath = '../../web/src/api.ts';
const { api, setCacheStateHandler } = await import(clientPath);

test('a cached slow API response checks server health before warning', async () => {
  const original = globalThis.fetch;
  const states: boolean[] = [];
  globalThis.fetch = async (input) => String(input) === '/api/health'
    ? new Response('{"ok":true}')
    : new Response('[]', { headers: { 'X-Corral-Cache': 'hit' } });
  setCacheStateHandler((state: boolean) => states.push(state));
  try {
    await api.listTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(states, [false]);
  } finally { globalThis.fetch = original; setCacheStateHandler(null); }
});

test('a failed health check warns and a fresh response clears it', async () => {
  const original = globalThis.fetch;
  const states: boolean[] = [];
  let stale = true;
  globalThis.fetch = async (input) => String(input) === '/api/health'
    ? new Response('{}', { status: 503, headers: { 'X-Corral-Cache': 'miss' } })
    : new Response('[]', { headers: stale ? { 'X-Corral-Cache': 'hit' } : {} });
  setCacheStateHandler((state: boolean) => states.push(state));
  try {
    await api.listTasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    stale = false;
    await api.listTasks();
    assert.deepEqual(states, [true, false]);
  } finally { globalThis.fetch = original; setCacheStateHandler(null); }
});
