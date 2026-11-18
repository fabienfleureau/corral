import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrillRound, formatGrillAnswers } from '../../web/src/grill-format.ts';

test('parses numbered questions, choices and recommendations', () => {
  const round = parseGrillRound(`❓ **Q1** - **Threat model**: Who? Pick one or more:\n\n(a) User\n(b) Third party\n(c) Both\n➡️ (c). Both.\n\n---\n\n❓ Q2 - Scope?\n(a) Local\n(b) Remote\n➡️ (a). Local.`);
  assert.equal(round.length, 2);
  assert.deepEqual(round[0].choices, ['(a) User', '(b) Third party', '(c) Both']);
  assert.equal(round[0].multiple, true);
  assert.match(round[0].recommendation, /Both/);
  assert.equal(formatGrillAnswers(round, { Q1: ['(c) Both', 'Prioritise b'], Q2: '(a) Local' }), 'Q1: (c) Both; Prioritise b\nQ2: (a) Local');
});

test('parses lettered and numbered choices, including French multi-select', () => {
  const round = parseGrillRound(`❓ **Q1** - Forme du goal ? (plusieurs choix)\n- A. Structuré : valeur cible + sens\n- B. Texte libre seulement\n➡️ A. La cible chiffrée permet de calculer l'écart.\n\n---\n\n❓ Q2 - Tâches supplémentaires ?\n1. Trajectoire : écart au goal\n2. Suivi d'impact : mesurer après la PR\n➡️ 1.`);
  assert.equal(round.length, 2);
  assert.deepEqual(round[0].choices, ['A. Structuré : valeur cible + sens', 'B. Texte libre seulement']);
  assert.equal(round[0].multiple, true);
  assert.equal(round[0].prompt, 'Forme du goal ? (plusieurs choix)');
  assert.match(round[0].recommendation, /La cible chiffrée/);
  assert.deepEqual(round[1].choices, ['1. Trajectoire : écart au goal', `2. Suivi d'impact : mesurer après la PR`]);
});

test('ignores unrelated text', () => assert.deepEqual(parseGrillRound('Normal question?'), []));
