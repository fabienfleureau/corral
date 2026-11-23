import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrillRound, formatGrillAnswers } from '../../web/src/grill-format.ts';

test('parses numbered questions, choices and recommendations', () => {
  const round = parseGrillRound(`❓ **Q1** - **Threat model**: Who? Pick one or more:\n\n(a) User\n(b) Third party\n(c) Both\n➡️ (c). Both.\n\n---\n\n❓ Q2 - Scope?\n(a) Local\n(b) Remote\n➡️ (a). Local.`);
  assert.equal(round.length, 2);
  assert.equal(round[0].prompt, '**Threat model**: Who? Pick one or more:');
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

test('parses numbered and fraction question headers with bolded choices and French recommendation', () => {
  const round = parseGrillRound(`Super : **Solo + voix intérieures** !

❓ **5/5. Côté ergonomie mobile et visuels simples :**
- **A. Portrait à une main, thème sombre AMOLED** — interface épurée.
- **B. Portrait avec mini-carte en haut** + fil narratif en bas.
- **C. Paysage (horizontal)** pour une interface classique.

➡️ **Recommandation :** **A** ou **B** (thème sombre AMOLED).`);
  assert.equal(round.length, 1);
  assert.equal(round[0].id, 'Q5');
  assert.equal(round[0].prompt, '**Côté ergonomie mobile et visuels simples :**');
  assert.deepEqual(round[0].choices, [
    'A. Portrait à une main, thème sombre AMOLED — interface épurée.',
    'B. Portrait avec mini-carte en haut + fil narratif en bas.',
    'C. Paysage (horizontal) pour une interface classique.',
  ]);
  assert.equal(round[0].recommendation, 'A ou B (thème sombre AMOLED).');
});

test('parses Q-prefixed headers with em-dash, colon inside bold, headings, and plain numbered questions', () => {
  const round = parseGrillRound(`❓ **Q1:** How should sections work?
- **(a)** Semantic wrappers
- **(b)** Heading walk
➡️ **(a)** — deterministic.

---

### ❓ Q2 — Diff view?
- **A** — Line + word diff
- **B** — Line diff only
➡️ A.

---

❓ **3. Keep drafts locally?**
1. Yes
2. No
➡️ 1.`);
  assert.equal(round.length, 3);
  assert.equal(round[0].id, 'Q1');
  assert.equal(round[0].prompt, 'How should sections work?');
  assert.deepEqual(round[0].choices, ['(a) Semantic wrappers', '(b) Heading walk']);
  assert.equal(round[0].recommendation, '(a) — deterministic.');
  assert.equal(round[1].id, 'Q2');
  assert.equal(round[1].prompt, 'Diff view?');
  assert.deepEqual(round[1].choices, ['A — Line + word diff', 'B — Line diff only']);
  assert.equal(round[2].id, 'Q3');
  assert.equal(round[2].prompt, '**Keep drafts locally?**');
  assert.deepEqual(round[2].choices, ['1. Yes', '2. No']);
});
