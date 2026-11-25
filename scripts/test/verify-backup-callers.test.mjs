// scripts/test/verify-backup-callers.test.mjs
//
// Phase 5: every caller that verifies a real backup goes through
// verifyBackupStream. The three CLIs must pass a >=10 MiB backup with a
// whole-file-read trap preloaded (DW-5.1), a truncated big archive must fail,
// and selfhost-check.mjs must no longer call the sync verifier (DW-5.2).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const IMPL = path.join(ROOT, 'backup', 'verify-backup.mjs');
const LIB = path.join(ROOT, 'scripts', 'lib', 'verify-backup.mjs');
const SELFHOST = path.join(ROOT, 'scripts', 'selfhost-check.mjs');
const TRAP = path.join(HERE, 'fixtures', 'trap-whole-read.mjs');

/** A tar with one file entry (same hand-built shape as the Phase 3/4 oracles). */
function tinyTar(name, content) {
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644', 100, 'latin1');
  header.write('0000000', 108, 'latin1');
  header.write('0000000', 116, 'latin1');
  header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 'latin1');
  header.write('00000000000 ', 136, 'latin1');
  header.write('        ', 148, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');

  const body = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
  content.copy(body);
  return Buffer.concat([header, body, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]);
}

function bigBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE t (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('big.bin', randomBytes(11 * 1024 * 1024))));
  return dir;
}

/** Spawn a CLI with the whole-file-read trap preloaded. */
function cli(args) {
  return spawnSync(process.execPath, ['--import', pathToFileURL(TRAP).href, ...args], { encoding: 'utf8' });
}

test('DW-5.1: both CLIs and --newest stream a >=10 MiB backup under the whole-read trap', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vl-callers-'));
  try {
    const dir = path.join(root, '2026-11-18T00-00-00Z');
    bigBackup(dir);
    const archive = path.join(dir, 'volumes', 'archives.tar.gz');
    assert.ok(statSync(archive).size >= 10 * 1024 * 1024, 'fixture must be at least 10 MiB');

    for (const [name, args] of [
      ['backup/verify-backup.mjs', [IMPL, dir]],
      ['scripts/lib/verify-backup.mjs', [LIB, dir]],
      ['backup/verify-backup.mjs --newest', [IMPL, '--newest', root]],
    ]) {
      const res = cli(args);
      assert.equal(res.status, 0, `${name}: stdout=${res.stdout} stderr=${res.stderr}`);
      assert.match(res.stdout, /verified: /, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DW-5.1: the CLI on a truncated big archive exits 1 under the trap', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vl-callers-'));
  try {
    const dir = path.join(root, '2026-11-18T00-00-00Z');
    bigBackup(dir);
    const archive = path.join(dir, 'volumes', 'archives.tar.gz');
    const gz = readFileSync(archive);
    writeFileSync(archive, gz.subarray(0, Math.floor(gz.length / 2)));

    const res = cli([IMPL, dir]);
    assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, /not verified: volume archive archives\.tar\.gz is unreadable/);
    assert.equal(statSync(path.join(dir, 'verified'), { throwIfNoEntry: false }), undefined, 'no marker on a failed backup');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DW-5.2: selfhost-check imports the stream and never calls verifyBackup(', () => {
  const text = readFileSync(SELFHOST, 'utf8');
  assert.match(text, /import\s*\{[^}]*\bverifyBackupStream\b[^}]*\}\s*from\s*'\.\/lib\/verify-backup\.mjs'/);
  assert.ok(!/\bverifyBackup\(/.test(text), 'no synchronous verifyBackup call remains');
  assert.match(text, /await\s+verifyBackupStream\(produced\)/);
});
