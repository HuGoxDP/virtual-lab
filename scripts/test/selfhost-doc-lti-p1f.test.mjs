// scripts/test/selfhost-doc-lti-p1f.test.mjs
//
// P1f / MS-2 AC-19, doc half: step 3 of docs/self-host.md sold `--issuer` as the answer to
// a Moodle whose public address differs. That advice cannot work: `normaliseRegistration`
// refuses a row whose auth/token/jwks endpoints are not on the issuer's origin (the same
// origin Moodle signs AGS requests from), so a different host typed into `--issuer` leaves
// the endpoints off-origin and the row is never written. The step must now state the origin
// rule, that `--deployment-id` may be repeated (the script accumulates them), and keep the
// guard phrases the earlier P1c/P1e doc tests pin.
//
// Separate file on purpose (ADR-0005 test guard): an existing test file may not be edited, a
// new one may be added. Pattern: selfhost-doc-lti-issuer.test.mjs — fs reads + node:test.

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

/** «Крок 3» of the LTI section, the only slice this task may touch. */
function step3() {
  const lti = section('Робота як LTI-інструмент');
  const from = lti.indexOf('### Крок 3');
  const to = lti.indexOf('### Крок 4');
  assert.ok(from !== -1 && to !== -1 && from < to, 'Крок 3 must be locatable between Крок 3 and Крок 4');
  return lti.slice(from, to);
}

test('self-host doc: step 3 no longer sends a different public address to --issuer', () => {
  const step = step3();
  assert.ok(!/додайте `--issuer`/.test(step),
    'the old advice «додайте --issuer ...» cannot work: it leaves the Moodle endpoints off the issuer origin');
  assert.ok(!/Якщо публічна адреса Moodle інша/.test(step), 'the premise of that advice is gone');
  // The flag still exists for a same-origin sub-path issuer, so it may be named — not advised
  // as the fix for a different host.
  assert.ok(!/--issuer <Platform ID>/.test(step), 'the concrete command form of the advice is gone');
});

test('self-host doc: step 3 states every endpoint must be on the issuer origin', () => {
  const step = step3();
  assert.match(step, /origin/, 'the origin rule must be named');
  assert.match(step, /auth[\s\S]{0,80}token[\s\S]{0,80}keyset/, 'the three endpoints must be named together');
  assert.ok(/(auth, token і keyset|усі три адреси)/i.test(step),
    'the constraint must cover all three endpoints, not one example');
});

test('self-host doc: step 3 says --deployment-id may be repeated', () => {
  const step = step3();
  assert.match(step, /`--deployment-id` можна повторити/,
    'a Moodle with several deployment ids must be told to repeat the flag');
});

test('self-host doc: step 3 keeps the phrases the earlier LTI doc tests pin', () => {
  const step = step3();
  assert.match(step, /issuer/, 'the new sentence must name the issuer');
  assert.ok(step.includes('https://host/moodle'), 'the sub-path example must be present');
  assert.match(step, /саме тим рядком/, 'the sentence must say the issuer is stored exactly as given');
  assert.match(step, /Platform ID/, 'the issuer must be tied to Moodle\'s Platform ID (iss)');
});

test('self-host doc: no «Що нового» bullet added — the newest is still HO1b 2026-11-23', () => {
  const newest = DOC.slice(DOC.indexOf('### Що нового')).match(/^- \*\*(\d{4}-\d{2}-\d{2})/m);
  assert.ok(newest, 'the newest bullet must be locatable');
  assert.equal(newest[1], '2026-11-23', 'this task adds no «Що нового» entry (HO1b stays newest)');
});