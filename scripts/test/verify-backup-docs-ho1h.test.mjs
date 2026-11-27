// scripts/test/verify-backup-docs-ho1h.test.mjs
//
// HO1h AC-20 docs: backup-restore.md states the EACCES symptom only for a
// non-root host run (the image writes the marker as root), and self-host.md
// lists both marker symptoms. New file: the pinned docs tests stay untouched.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKUP_DOC = readFileSync(path.join(ROOT, 'docs', 'backup-restore.md'), 'utf8');
const SELF_HOST = readFileSync(path.join(ROOT, 'docs', 'self-host.md'), 'utf8');

/** «Як оновитися» step 1 — the slice verify-backup-docs.test.mjs pins. */
function updateStep1() {
  const updateStart = SELF_HOST.indexOf('## Оновлення');
  const start = SELF_HOST.indexOf('1. **', updateStart);
  const end = SELF_HOST.indexOf('2. Оновіть код', start);
  assert.ok(start !== -1 && end > start, 'update step 1 must be locatable');
  return SELF_HOST.slice(start, end);
}

// ── DW-3.1: no unconditional root-owned/EACCES claim ──
test('backup-restore.md: EACCES is named only as a non-root host-run symptom', () => {
  const lines = BACKUP_DOC.split('\n');
  const claims = lines.filter(line => /EACCES|root-owned/.test(line));
  assert.ok(claims.length > 0, 'the host-alternative caveat must be present');
  for (const line of claims) {
    assert.match(line, /non-root/, `the caveat must say non-root: ${line}`);
    assert.match(line, /EACCES/, `the caveat must name EACCES: ${line}`);
    assert.match(line, /host/, `the caveat must be about the host run: ${line}`);
  }
  // The host command itself stays a comment (pinned by verify-backup-docs.test.mjs).
  assert.match(BACKUP_DOC, /^#\s*node scripts\/lib\/verify-backup\.mjs "backup\/out-scratch\/\$NAME"/m,
    'the host alternative command must remain a comment');
});

// ── DW-3.2: both marker symptoms in the backup part of self-host.md ──
test('self-host.md: the non-root host run names both marker symptoms', () => {
  const step1 = updateStep1();
  for (const symptom of ['cannot write the verified marker', 'cannot remove the stale verified marker']) {
    assert.ok(SELF_HOST.includes(symptom), `self-host.md must list "${symptom}"`);
    assert.ok(step1.includes(symptom), `update step 1 must list "${symptom}": ${step1}`);
  }
  // The pinned HO1b «Що нового» entry stays the newest one.
  const whatsNew = SELF_HOST.slice(SELF_HOST.indexOf('### Що нового'));
  const first = whatsNew.indexOf('- **');
  assert.match(whatsNew.slice(first), /^- \*\*2026-11-23/, 'the newest entry must remain HO1b\'s');
});
