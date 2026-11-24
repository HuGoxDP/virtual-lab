// scripts/test/selfhost-doc-lti-issuer.test.mjs
//
// P1e Phase 3: step 3b of docs/self-host.md must state that the issuer is stored
// exactly as given and must equal Moodle's Platform ID (iss), sub-path included
// (https://host/moodle), with no trailing slash added or removed. Pattern:
// selfhost-doc-lti-manual-registration.test.mjs — fs reads + node:test, no Docker.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = readFileSync(path.join(ROOT, 'docs', 'self-host.md'), 'utf8');

function section(title) {
  const start = DOC.indexOf(`## ${title}`);
  assert.notEqual(start, -1, `section "## ${title}" must exist`);
  const rest = DOC.slice(start + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? DOC.slice(start) : DOC.slice(start, start + 1 + next);
}

test('self-host doc: step 3 says the issuer is stored verbatim, sub-path included', () => {
  const lti = section('Робота як LTI-інструмент');
  const step3 = lti.slice(lti.indexOf('### Крок 3'), lti.indexOf('### Крок 4'));
  assert.ok(step3.length > 0, 'Крок 3 must be locatable');
  assert.match(step3, /issuer/, 'the new sentence must name the issuer');
  assert.ok(step3.includes("https://host/moodle"), "the sub-path example must be present");
  assert.match(step3, /саме тим рядком/, "the sentence must say the issuer is stored exactly as given");
  assert.match(step3, /Platform ID/, 'the issuer must be tied to Moodle\'s Platform ID (iss)');
});
