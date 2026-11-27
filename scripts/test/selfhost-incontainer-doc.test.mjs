// scripts/test/selfhost-incontainer-doc.test.mjs
//
// HO1b2 Phase 2 (DW-2.1, DW-2.2): the self-check section must teach the opt-in
// `--verify-in-container` flag, and the flag must not leak into any other
// section of docs/self-host.md. Pattern: selfhost-doc.test.mjs — fs reads +
// node:test, no Docker and no spawned commands.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = readFileSync(path.join(ROOT, 'docs', 'self-host.md'), 'utf8');

/** Absolute offsets of the `## Перевірка …` section in the full document. */
const start = DOC.indexOf('## Перевірка');
assert.notEqual(start, -1, 'the self-check section must exist');
const afterHeading = DOC.slice(start + 1);
const next = afterHeading.search(/^## /m);
const end = next === -1 ? DOC.length : start + 1 + next;
const section = DOC.slice(start, end);

test('DW-2.1 the self-check section teaches the flag, its child, its failure and its ref requirement', () => {
  assert.match(section, /--verify-in-container/, 'the flag is in the self-check section');
  assert.match(section, /verify-backup\.mjs --newest \/backups/, 'the in-image verifier command is named');
  assert.match(section, /RED at backup/, 'an old ref’s missing verifier is an honest failure');
  const bullets = section.split(/\n(?=- )/);
  const refBullet = bullets.find(b => b.includes('Потрібен `--ref`'));
  assert.ok(refBullet, 'the --ref requirement is described here');
  assert.match(refBullet, /HO1b|2026-11-23/, 'the ref requirement says when the verifier shipped');
  const usage = section.split('\n').find(l => l.startsWith('npm run selfhost-check -- --lock'));
  assert.ok(usage, 'the usage code line lives in this section');
  assert.match(usage, /\[--verify-in-container\]/, 'the usage line offers the flag');
});

test('DW-2.2 --verify-in-container occurs only inside the self-check section', () => {
  const needle = '--verify-in-container';
  const offsets = [];
  let at = DOC.indexOf(needle);
  while (at !== -1) {
    offsets.push(at);
    at = DOC.indexOf(needle, at + needle.length);
  }
  assert.ok(offsets.length > 0, 'the flag must be documented');
  for (const offset of offsets) {
    assert.ok(offset >= start && offset < end,
      `an occurrence at offset ${offset} is outside «Перевірка» (${start}…${end})`);
  }
});
