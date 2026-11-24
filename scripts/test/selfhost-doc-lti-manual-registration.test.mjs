// scripts/test/selfhost-doc-lti-manual-registration.test.mjs
//
// P1c: «Крок 3 — ручна реєстрація» in docs/self-host.md used to be a dead end. The tool learns a
// platform only through Dynamic Registration (`backend/lti/registration.js` is the only
// `store.saveRegistration` caller; `backend/lti/launch.js` answers 403 «Платформа не зареєстрована»
// for any other issuer), so an admin whose Moodle blocks dynamic registration filled Moodle's form
// and every launch was 403. The step must now carry the tool-side half, name Moodle's REAL form
// fields, and stop claiming a live verification it never had.
//
// Separate file on purpose (ADR-0005 test guard): an existing test file may not be edited, a new
// one may be added. Pattern: selfhost-doc.test.mjs — fs reads + node:test, no Docker.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = readFileSync(path.join(ROOT, 'docs', 'self-host.md'), 'utf8');

/** The body of one `## <title…>` section, up to the next `## ` heading. */
function section(title) {
  const start = DOC.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `section "## ${title}" must exist`);
  const rest = DOC.slice(start + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? DOC.slice(start) : DOC.slice(start, start + 1 + next);
}

test('self-host doc: manual LTI registration names the tool-side script and Moodle\'s real fields', () => {
  const lti = section('Робота як LTI-інструмент');
  const step3 = lti.slice(lti.indexOf('### Крок 3'), lti.indexOf('### Крок 4'));
  assert.ok(step3.length > 0, 'Крок 3 must be locatable');
  assert.match(step3, /lti-add-registration\.js/, 'the tool-side half must be a runnable command');
  assert.match(step3, /docker compose exec backend/, 'it runs in the backend container');
  assert.match(step3, /403/, 'the failure it fixes must be named');
  for (const field of ['LTI version', 'Keyset URL', 'Supports Deep Linking',
    'IMS LTI Assignment and Grade Services', 'Accept grades']) {
    assert.ok(step3.includes(field), `Moodle's form field "${field}" must be listed`);
  }
  assert.ok(!/Метод автентифікації/.test(step3), 'a field Moodle\'s form does not have must not be listed');
  assert.ok(!/Target link URI/.test(step3), 'Moodle 5 names it Tool URL / Redirection URI(s)');
  assert.match(step3, /не живим запуском|не живим/i, 'the step must state that it was not verified live');
});

test('self-host doc: the LTI section does not claim every step was verified live', () => {
  const lti = section('Робота як LTI-інструмент');
  assert.ok(!/Кроки перевірені на Moodle/.test(lti),
    'the blanket «Кроки перевірені» claim covered a step that was never run live');
  assert.match(lti, /Крок 2[\s\S]{0,120}перевірений/, 'the live-verified step must be named as such');
});
