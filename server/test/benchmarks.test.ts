import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSwe, parseTerminal } from '../benchmarks.ts';

test('published results preserve configuration and scores', () => {
  const swe = parseSwe({ leaderboards: [{ name: 'Verified', results: [{ folder: 'run', agent: 'Codex', model_display: 'Model', reasoning_effort: null, resolved: 70, date: '2026-01-01' }] }] });
  assert.equal(swe[0].score, 70);
  assert.equal(swe[0].reasoning, null);
  const terminal = parseTerminal({ metadata: { agent_display: { label: 'Codex' }, model_display: { label: 'Model' }, reasoning_effort: 'high', date: '2026-01-01' }, metrics: { accuracy: 45 } }, 'run.json');
  assert.equal(terminal?.reasoning, 'high');
  assert.equal(terminal?.score, 45);
  assert.equal(parseTerminal({}, 'bad.json'), null);
});

test('manual results persist independently of published snapshots and can be removed', async () => {
  const { Db } = await import('../db.ts');
  const { getBenchmarks, saveManualBenchmark, deleteManualBenchmark } = await import('../benchmarks.ts');
  const db = new Db(':memory:');
  saveManualBenchmark(db, { model: 'GPT-6', benchmark: 'SWE-bench Verified', score: 42 });
  db.raw.prepare('INSERT INTO benchmark_snapshot VALUES (1, ?, ?)').run(123, '[]');
  assert.equal(getBenchmarks(db).manual[0].score, 42);
  saveManualBenchmark(db, { model: 'GPT-6', benchmark: 'SWE-bench Verified', score: 0 });
  assert.equal(getBenchmarks(db).manual.length, 1);
  assert.equal(getBenchmarks(db).manual[0].score, 0);
  assert.throws(() => saveManualBenchmark(db, { model: 'GPT-6', benchmark: 'SWE-bench Verified', score: 101 }));
  deleteManualBenchmark(db, 'GPT-6', 'SWE-bench Verified');
  assert.equal(getBenchmarks(db).manual.length, 0);
  db.close();
});
