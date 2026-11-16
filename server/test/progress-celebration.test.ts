import { test } from 'node:test';
import assert from 'node:assert/strict';
import { achievements } from '../../web/src/progress-celebration.ts';

test('announces only newly crossed levels and badge thresholds', () => {
  assert.deepEqual(achievements({ level: 1, tasks: 0, inbox: 9 }, { level: 2, tasks: 10, inbox: 10 }), ['Level 2 reached', 'Tasks created · 1', 'Tasks created · 10', 'Inbox handled · 10']);
  assert.deepEqual(achievements({ level: 2, tasks: 10, inbox: 10 }, { level: 2, tasks: 10, inbox: 10 }), []);
});
