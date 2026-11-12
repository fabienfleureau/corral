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
  reviewFromHash,
  reviewTaskHash,
  selectionTaskHash,
  taskPrefillFromHash,
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

test('a review deep link carries the PR/MR URL verbatim', () => {
  const url = 'https://gitlab.com/group/sub/project/-/merge_requests/12?tab=notes';
  const hash = reviewTaskHash(url);
  assert.ok(hash.startsWith('#/tasks?review='));
  assert.equal(reviewFromHash(hash), url);
  assert.deepEqual(taskPrefillFromHash(hash), { prUrl: url });
  assert.deepEqual(taskPrefillFromHash(selectionTaskHash('Fix the retry loop')), { text: 'Fix the retry loop' });
});

test('only a tasks deep link prefills anything, and only a URL prefills a review', () => {
  assert.equal(reviewFromHash('#/tasks?review='), null);
  assert.equal(reviewFromHash('#/tasks?review=not-a-url'), null);
  assert.equal(reviewFromHash('#/tasks?prompt=hello'), null);
  assert.equal(reviewFromHash('#/pulls?review=https%3A%2F%2Fgithub.com%2Fa%2Fb%2Fpull%2F1'), null);
  assert.equal(reviewFromHash(''), null);
  assert.equal(taskPrefillFromHash('#/tasks'), null);
});
