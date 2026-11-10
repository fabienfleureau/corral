import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkColumns, buildBenchmarkRows, compareVersions, parseModelName, sameModel } from '../../web/src/model-match.ts';

test('published labels and harness ids resolve to the same identity', () => {
  assert.deepEqual(parseModelName('Claude 4.5 Opus'), { family: 'claude', variant: 'opus', version: '4.5' });
  assert.deepEqual(parseModelName('opus'), { family: 'claude', variant: 'opus', version: null });
  assert.deepEqual(parseModelName('Opus 5.5'), { family: 'claude', variant: 'opus', version: '5.5' });
  assert.deepEqual(parseModelName('opencode/claude-sonnet-5-5'), { family: 'claude', variant: 'sonnet', version: '5.5' });
  assert.deepEqual(parseModelName('Claude Sonnet 3.5'), { family: 'claude', variant: 'sonnet', version: '3.5' });
  assert.deepEqual(parseModelName('claude-fable-5-1[1m]'), { family: 'claude', variant: 'fable', version: '5.1' });
  assert.deepEqual(parseModelName('gpt-6.1-sol'), { family: 'gpt', variant: 'sol', version: '6.1' });
  assert.deepEqual(parseModelName('GPT-5.6 Terra'), { family: 'gpt', variant: 'terra', version: '5.6' });
  assert.deepEqual(parseModelName('GLM-5.3-Flash'), { family: 'glm', variant: 'flash', version: '5.3' });
  assert.deepEqual(parseModelName('opencode-go/glm-5.3-flash'), { family: 'glm', variant: 'flash', version: '5.3' });
  assert.deepEqual(parseModelName('muse-spark-1.3-contributor'), { family: 'muse', variant: 'spark', version: '1.3' });
  assert.deepEqual(parseModelName('Muse Spark 1.3'), { family: 'muse', variant: 'spark', version: '1.3' });
  assert.deepEqual(parseModelName('Claude 3.5-Sonnet-20241022'), { family: 'claude', variant: 'sonnet', version: '3.5' });
  assert.deepEqual(parseModelName('Qwen2.5-Coder 32B Instruct'), { family: 'qwen', variant: 'coder instruct', version: '2.5' });
  assert.deepEqual(parseModelName('anthropic/claude-opus-4-1'), { family: 'claude', variant: 'opus', version: '4.1' });
});

test('identity matching is order-free, alias-aware and version-aware', () => {
  assert.ok(sameModel(parseModelName('Claude 4.5 Opus'), parseModelName('opus')));
  assert.ok(sameModel(parseModelName('Claude 4.5 Opus'), parseModelName('Opus 4.5')));
  assert.ok(!sameModel(parseModelName('Claude 4.5 Opus'), parseModelName('Opus 5.5')));
  assert.ok(!sameModel(parseModelName('Claude 4.5 Opus'), parseModelName('Claude 4.5 Sonnet')));
  assert.ok(sameModel(parseModelName('GLM-5.3'), parseModelName('GLM 5.3')));
  assert.equal(compareVersions('5.5', '5') > 0, true);
  assert.equal(compareVersions('5.10', '5.9') > 0, true);
  assert.equal(compareVersions('6', '6.0'), 0);
});

const result = (model: string, benchmark: string, score: number, agent = 'agent', extra: { reasoning?: string | null; date?: string | null } = {}) => ({
  id: `${benchmark}/${model}/${agent}/${score}`, benchmark, agent, model, score,
  reasoning: extra.reasoning ?? null, date: extra.date ?? null, source: `https://example.test/${encodeURIComponent(model)}/${score}`,
});

test('rows match published results to harness models and keep the best score per benchmark', () => {
  const rows = buildBenchmarkRows(
    [
      { harness: 'claude', id: 'opus', label: 'Opus' },
      { harness: 'opencode', id: 'opencode/claude-opus-5-5', label: 'opencode/claude-opus-5-5' },
      { harness: 'codex', id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    ],
    [
      result('Opus 5.5', 'SWE-bench Verified', 70, 'mini-SWE-agent', { date: '2026-01-01' }),
      result('Claude Opus 5.5', 'SWE-bench Verified', 76.8),
      result('Opus 5.5', 'SWE-bench Verified', 79.2, 'Sonar Foundation Agent', { date: '2026-02-01' }),
      result('GPT-6.1 Sol', 'Terminal-Bench 4.0', 55.5, 'Codex'),
    ],
  );
  assert.equal(rows.length, 2);
  const opus = rows[0];
  assert.equal(opus.label, 'Opus 5.5');
  assert.deepEqual(opus.availability.map((model) => model.harness), ['claude', 'opencode']);
  assert.equal(opus.picks['SWE-bench Verified'].result.score, 79.2);
  assert.equal(opus.picks['SWE-bench Verified'].alternatives, 2);
  assert.equal(opus.picks['SWE-bench Verified'].result.source, 'https://example.test/Opus%205.5/79.2');
  const sol = rows[1];
  assert.equal(sol.label, 'GPT-6.1 Sol');
  assert.equal(sol.picks['Terminal-Bench 4.0'].result.agent, 'Codex');
});

test('unversioned aliases follow the newest published version of their family', () => {
  const rows = buildBenchmarkRows(
    [{ harness: 'claude', id: 'sonnet', label: 'Sonnet' }],
    [result('Claude 4.5 Sonnet', 'SWE-bench Verified', 70.6), result('Sonnet 5.5', 'SWE-bench Verified', 74.8)],
  );
  const mine = rows.filter((row) => row.availability.length > 0);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].label, 'Sonnet 5.5');
  assert.equal(mine[0].picks['SWE-bench Verified'].result.score, 74.8);
  // The older version stays available as a published-only row.
  assert.deepEqual(rows.filter((row) => !row.availability.length).map((row) => row.label), ['Claude 4.5 Sonnet']);
});

test('harness models without a published result stay listed, published strangers come last', () => {
  const rows = buildBenchmarkRows(
    [{ harness: 'opencode', id: 'opencode/gemini-3.5-flash-lite', label: 'opencode/gemini-3.5-flash-lite' }],
    [result('Gemini 3.8 Flash', 'SWE-bench Verified', 75.8)],
  );
  assert.deepEqual(rows.map((row) => [row.label, row.availability.length]), [
    ['opencode/gemini-3.5-flash-lite', 1],
    ['Gemini 3.8 Flash', 0],
  ]);
  assert.deepEqual(benchmarkColumns(rows), ['SWE-bench Verified']);
});
