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
