// scripts/test/restore-hint-quoting.test.mjs
//
// HO1h AC-20: restore.mjs's "verify it first" hint must quote a backup name a
// shell would reinterpret (spaces, quotes, `$`, backticks), while a plain
// timestamp name stays byte-identical to the old hint. New file only.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESTORE = path.join(ROOT, 'backup', 'restore.mjs');

/** Spawn restore.mjs against an unverified backup in a temp BACKUP_DIR. */
function refusal(name) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vl-restore-hint-'));
  try {
    mkdirSync(path.join(root, name));
    const res = spawnSync(process.execPath, [RESTORE, name], {
      encoding: 'utf8',
      env: { ...process.env, BACKUP_DIR: root },
    });
    assert.ifError(res.error);
    return res;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The POSIX single-quoted token the hint must contain for an unsafe name. */
const quoted = (name) => `'${name.replace(/'/g, "'\\''")}'`;

// ── DW-2.1: a name with spaces is quoted in both command lines ──
test('restore hint: a name with spaces is quoted in both verify commands', () => {
  const name = '2026 11 25';
  const res = refusal(name);
  assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
  assert.ok(res.stderr.includes(`/backups/${quoted(name)}`),
    `the in-image command must quote the name: ${res.stderr}`);
  assert.ok(res.stderr.includes(`<host backup folder>/${quoted(name)}`),
    `the host command must quote the name: ${res.stderr}`);
  assert.ok(!res.stderr.includes(`/backups/${name} `),
    `an unquoted spaced name must not be suggested: ${res.stderr}`);
});

// ── DW-2.2: a plain timestamp name prints exactly the base hint lines ──
test('restore hint: a plain timestamp name is byte-identical to the base', () => {
  const name = '2026-11-25T00-00-00Z';
  const res = refusal(name);
  assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
  assert.ok(res.stderr.includes(`verify it first: docker compose run --rm --entrypoint node backup verify-backup.mjs /backups/${name}`),
    `the in-image line must be unchanged: ${res.stderr}`);
  assert.ok(res.stderr.includes(`  (or on the host, with Node 22+: node scripts/lib/verify-backup.mjs <host backup folder>/${name})`),
    `the host line must be unchanged: ${res.stderr}`);
  assert.ok(!res.stderr.includes(`'${name}'`), `a safe name needs no quotes: ${res.stderr}`);
});

// ── DW-2.3: quotes, `$` and backticks are escaped by the same rule ──
test('restore hint: an embedded quote uses the POSIX end/escape/restart form', () => {
  const name = "2026'11'25";
  const res = refusal(name);
  assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
  assert.ok(res.stderr.includes(`/backups/${quoted(name)}`),
    `the quoted token must be ${quoted(name)}: ${res.stderr}`);
  assert.ok(res.stderr.includes(`<host backup folder>/${quoted(name)}`),
    `the host command must escape quotes too: ${res.stderr}`);
});

test('restore hint: shell metacharacters are quoted without being expanded', () => {
  const name = '2026 $HOME `id`';
  const res = refusal(name);
  assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
  assert.ok(res.stderr.includes(`/backups/${quoted(name)}`),
    `the whole unsafe name must be quoted: ${res.stderr}`);
  assert.ok(res.stderr.includes('$HOME'), 'the literal text is kept in the hint');
  assert.ok(res.stderr.includes('`id`'), 'the literal backticks are kept in the hint');
});
