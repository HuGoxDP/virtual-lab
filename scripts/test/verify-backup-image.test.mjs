// scripts/test/verify-backup-image.test.mjs
//
// HO1b Phase 1: the verifier ships in the backup image (backup/verify-backup.mjs,
// COPY'd by backup/Dockerfile), the lib re-exports the very same functions, a
// marker that cannot be removed or written is a named {ok:false} instead of an
// exception, and both CLIs accept `--newest <root>`. `node --test`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import * as img from '../../backup/verify-backup.mjs';
import * as lib from '../lib/verify-backup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMG_CLI = path.join(ROOT, 'backup', 'verify-backup.mjs');
const LIB_CLI = path.join(ROOT, 'scripts', 'lib', 'verify-backup.mjs');
const USAGE = 'usage: node verify-backup.mjs <backup-dir> | --newest <backup-root>';

/** A tar with one file entry, built by hand: valid header checksum, octal size, two zero blocks. */
function tinyTar(name, content) {
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644', 100, 'latin1');
  header.write('0000000', 108, 'latin1');
  header.write('0000000', 116, 'latin1');
  header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 'latin1');
  header.write('00000000000 ', 136, 'latin1');
  header.write('        ', 148, 'latin1'); // checksum field read as spaces while summing
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const body = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
  Buffer.from(content).copy(body);
  return Buffer.concat([header, body, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]);
}

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'vl-vbimg-'));
}

/** A backup directory that must pass — the same shape as verify-backup.test.mjs. */
function goodBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\nCREATE TABLE scenario_versions (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('objects/aa/hash.zip', 'zip-bytes')));
  writeFileSync(path.join(dir, 'volumes', 'lti.tar.gz'), gzipSync(tinyTar('tool-key.pem', 'pem-bytes')));
  return dir;
}

/** A backup that fails one check: the dump is valid gzip with no CREATE TABLE. */
function badBackup(dir) {
  goodBackup(dir);
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('-- no tables here\n'));
  return dir;
}

/** Spawn one entry file with the given argv (no node/script prefix). */
function cli(entry, args) {
  const res = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
  assert.ifError(res.error);
  return res;
}

/** Today's green check list — the exact names, in order; no marker check on green. */
const GREEN_CHECK_NAMES = [
  'db.sql.gz',
  'dump gunzips',
  'dump names tables',
  'manifest.json',
  'volume archives',
  'archive archives.tar.gz',
  'archive lti.tar.gz',
];

// ── DW-1.1: the image ships the verifier, and it imports nothing outside node: ──

test('the Dockerfile COPY line names verify-backup.mjs with the other three scripts', () => {
  const text = readFileSync(path.join(ROOT, 'backup', 'Dockerfile'), 'utf8');
  const copies = text.split('\n').filter(l => /^\s*COPY\b/.test(l));
  const line = copies.find(l => l.includes('verify-backup.mjs'));
  assert.ok(line, `no COPY line names verify-backup.mjs: ${JSON.stringify(copies)}`);
  for (const name of ['retention.mjs', 'backup.mjs', 'restore.mjs', 'verify-backup.mjs']) {
    assert.ok(line.includes(name), `COPY line must name ${name}: ${line}`);
  }
});

test('every import specifier in backup/verify-backup.mjs starts with node:', () => {
  const text = readFileSync(IMG_CLI, 'utf8');
  const specifiers = [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.ok(specifiers.length >= 3, `expected the module's imports, found ${specifiers.length}`);
  for (const spec of specifiers) {
    assert.ok(spec.startsWith('node:'), `non-builtin import: ${spec}`);
  }
});

// ── DW-1.2: the lib re-exports the very same functions ──

test('the lib re-exports the same function objects and the same marker constant', () => {
  assert.equal(lib.verifyBackup, img.verifyBackup);
  assert.equal(lib.newestBackup, img.newestBackup);
  assert.equal(lib.runCli, img.runCli);
  assert.equal(lib.VERIFIED_MARKER, img.VERIFIED_MARKER);
  assert.equal(img.VERIFIED_MARKER, 'verified');
});

// ── DW-1.3: both CLIs, spawned, agree on exits and output ──

test('both CLIs: a good dir exits 0 with verified: on stdout; a bad dir exits 1', () => {
  const good = goodBackup(tmp());
  const bad = badBackup(tmp());
  try {
    for (const entry of [IMG_CLI, LIB_CLI]) {
      const ok = cli(entry, [good]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.ok(ok.stdout.includes(`verified: ${good}`), ok.stdout);
      assert.ok(ok.stdout.includes('ok   db.sql.gz'), ok.stdout);
      const fail = cli(entry, [bad]);
      assert.equal(fail.status, 1, fail.stderr);
      assert.ok(fail.stdout.includes('not verified: '), fail.stdout);
      assert.ok(fail.stdout.includes('FAIL'), fail.stdout);
    }
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test('both CLIs: malformed invocations exit 2 with the usage line on stderr', () => {
  const dir = goodBackup(tmp());
  try {
    for (const entry of [IMG_CLI, LIB_CLI]) {
      for (const args of [[], ['--newest'], ['--x', dir], [dir, dir]]) {
        const res = cli(entry, args);
        assert.equal(res.status, 2, `${entry} ${JSON.stringify(args)}: ${res.stdout}${res.stderr}`);
        assert.ok(res.stderr.includes(USAGE), `usage line missing for ${JSON.stringify(args)}: ${res.stderr}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both CLIs: --newest on a missing root or one without timestamped dirs exits 2, named', () => {
  const root = tmp();
  try {
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    mkdirSync(path.join(root, 'not-a-backup'));
    for (const entry of [IMG_CLI, LIB_CLI]) {
      for (const target of [root, path.join(root, 'missing')]) {
        const res = cli(entry, ['--newest', target]);
        assert.equal(res.status, 2, res.stderr);
        assert.ok(res.stderr.includes(`no backup directory under ${target}`), res.stderr);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both CLIs: --newest picks the newest timestamped dir and names it before the checks', () => {
  const root = tmp();
  try {
    const older = goodBackup(path.join(root, '2026-11-17T09-15-04Z'));
    const newest = goodBackup(path.join(root, '2026-11-18T00-00-00Z'));
    for (const entry of [IMG_CLI, LIB_CLI]) {
      const res = cli(entry, ['--newest', root]);
      assert.equal(res.status, 0, res.stderr);
      const firstLine = res.stdout.split('\n')[0];
      assert.equal(firstLine, `newest backup: ${newest}`);
      assert.ok(res.stdout.indexOf('newest backup:') < res.stdout.indexOf('ok   db.sql.gz'), res.stdout);
      assert.ok(res.stdout.includes(`verified: ${newest}`), res.stdout);
    }
    // Newest bad, older good: --newest verifies the bad one and exits 1.
    writeFileSync(path.join(newest, 'db.sql.gz'), gzipSync('-- no tables here\n'));
    for (const entry of [IMG_CLI, LIB_CLI]) {
      const res = cli(entry, ['--newest', root]);
      assert.equal(res.status, 1, res.stderr);
      assert.ok(res.stdout.includes(`newest backup: ${newest}`), res.stdout);
      assert.ok(res.stdout.includes('not verified: '), res.stdout);
      assert.ok(!existsSync(path.join(older, img.VERIFIED_MARKER)), 'the older good backup is not touched');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── DW-1.4: a directory named `verified` — the base threw here (AC-10) ──

test('a directory named verified is a named marker failure, not an exception', () => {
  const dir = goodBackup(tmp());
  try {
    mkdirSync(path.join(dir, img.VERIFIED_MARKER));
    const result = img.verifyBackup(dir);
    assert.equal(result.ok, false);
    assert.match(result.error, /^cannot remove the stale verified marker: /);
    assert.equal(result.checks.length, 1, JSON.stringify(result.checks));
    assert.deepEqual(result.checks[0], {
      name: 'verified marker',
      ok: false,
      detail: result.error.slice('cannot remove the stale verified marker: '.length),
    });
    const res = cli(IMG_CLI, [dir]);
    assert.equal(res.status, 1, res.stderr);
    assert.ok(res.stdout.includes('FAIL verified marker'), res.stdout);
    assert.ok(res.stdout.includes('not verified: cannot remove the stale verified marker: '), res.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DW-1.5: a read-only backup dir — write EACCES (POSIX only, never as root) ──

test('a read-only backup dir fails only on writing the marker, named', () => {
  if (process.platform === 'win32') return; // chmod cannot make a dir read-only on Windows
  if (process.getuid?.() === 0) return; // root writes through 0o555
  const dir = goodBackup(tmp());
  try {
    chmodSync(dir, 0o555);
    const result = img.verifyBackup(dir);
    assert.equal(result.ok, false);
    assert.match(result.error, /^cannot write the verified marker: /);
    const last = result.checks[result.checks.length - 1];
    assert.equal(last.name, 'verified marker');
    assert.equal(last.ok, false);
    assert.ok(result.checks.slice(0, -1).every(c => c.ok), JSON.stringify(result.checks));
    assert.deepEqual(result.checks.slice(0, -1).map(c => c.name), GREEN_CHECK_NAMES);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DW-1.6: a green run is unchanged — same checks, no marker check, marker written ──

test('a good fixture keeps exactly today\'s check list, adds no marker check, writes the marker', () => {
  const dir = goodBackup(tmp());
  try {
    const result = img.verifyBackup(dir);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(Object.keys(result).sort(), ['checks', 'ok']);
    assert.deepEqual(result.checks.map(c => c.name), GREEN_CHECK_NAMES);
    assert.ok(result.checks.every(c => c.ok));
    assert.ok(!result.checks.some(c => c.name === 'verified marker'));
    assert.ok(existsSync(path.join(dir, img.VERIFIED_MARKER)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
