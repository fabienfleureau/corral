// Selecting a passage in the inbox hands it to the Tasks page as a prompt.
// The URL contract is the seam, so it is tested without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SELECTION_CHARS,
  MIN_SELECTION_CHARS,
  isTaskSelection,
  promptFromHash,
  promptFromSelection,
  selectionTaskHash,
} from '../../web/src/selection-task.ts';

test('a selection becomes a trimmed prompt', () => {
  assert.equal(promptFromSelection('  Deploy failed on\n  the payments service \n'), 'Deploy failed on\n  the payments service');
  assert.equal(promptFromSelection('windows\r\nline\rline'), 'windows\nline\nline');
  assert.equal(promptFromSelection(''), '');
  assert.equal(promptFromSelection(null), '');
  assert.equal(promptFromSelection(undefined), '');
  assert.equal(promptFromSelection('   \n\t '), '');
});

test('short selections are ignored, longer ones offered', () => {
  assert.equal(isTaskSelection(''), false);
  assert.equal(isTaskSelection('  a  '), false);
  assert.equal(isTaskSelection('x'.repeat(MIN_SELECTION_CHARS - 1)), false);
  assert.equal(isTaskSelection('x'.repeat(MIN_SELECTION_CHARS)), true);
  assert.equal(isTaskSelection('Blocked on the API key'), true);
});

test('a huge selection is capped so the deep link stays short', () => {
  const prompt = promptFromSelection('x'.repeat(MAX_SELECTION_CHARS + 500));
  assert.equal(prompt.length, MAX_SELECTION_CHARS + 1); // capped text plus the ellipsis
  assert.ok(prompt.endsWith('…'));
});

test('the tasks hash round-trips a prompt verbatim', () => {
  const prompt = 'Fix the retry loop:\n- a & b = 100%\n- "quoted" #hash ?query +plus';
  const hash = selectionTaskHash(prompt);
  assert.ok(hash.startsWith('#/tasks?prompt='));
  assert.equal(promptFromHash(hash), prompt);
  assert.equal(promptFromHash(hash.replace(/^#/, '')), prompt);
});

test('only the tasks route carries a prompt', () => {
  assert.equal(promptFromHash('#/tasks'), null);
  assert.equal(promptFromHash('#/tasks?prompt='), null);
  assert.equal(promptFromHash('#/tasks?prompt=%20%20'), null);
  assert.equal(promptFromHash('#/inbox?prompt=hello%20there'), null);
  assert.equal(promptFromHash('#/tasks?import=1'), null);
  assert.equal(promptFromHash(''), null);
});

test('prefilled prompts are normalized like a selection', () => {
  assert.equal(promptFromHash('#/tasks?prompt=%20hello%20%20'), 'hello');
});
