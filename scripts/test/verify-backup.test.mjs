// scripts/test/verify-backup.test.mjs
//
// The read-back that makes a backup a backup, over fixtures: a good backup
// passes and earns the `verified` marker; a truncated gzip, a manifest that is
// not JSON, an unreadable tar and a missing dump each fail with their named
// reason and never leave the marker behind. `node --test`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { newestBackup, VERIFIED_MARKER, verifyBackup } from '../lib/verify-backup.mjs';

/** A tar with one file entry, built by hand: valid header checksum, octal size, two zero blocks at the end. */
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
  return mkdtempSync(path.join(os.tmpdir(), 'vl-verify-'));
}

/** A backup directory that must pass. */
function goodBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\nCREATE TABLE scenario_versions (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z', volumes: [] }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('objects/aa/hash.zip', 'zip-bytes')));
  writeFileSync(path.join(dir, 'volumes', 'lti.tar.gz'), gzipSync(tinyTar('tool-key.pem', 'pem-bytes')));
  return dir;
}

test('a good backup passes every check and earns the verified marker', () => {
  const dir = goodBackup(tmp());
  const result = verifyBackup(dir);
  assert.equal(result.ok, true, result.error);
  assert.ok(result.checks.length >= 5);
  assert.ok(result.checks.every(c => c.ok));
  assert.ok(existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test('a missing db.sql.gz fails, named, and leaves no marker', () => {
  const dir = goodBackup(tmp());
  rmSync(path.join(dir, 'db.sql.gz'));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /db\.sql\.gz missing/);
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test('a truncated gzip fails as a gzip failure, not as SQL', () => {
  const dir = goodBackup(tmp());
  const gz = readFileSync(path.join(dir, 'db.sql.gz'));
  writeFileSync(path.join(dir, 'db.sql.gz'), gz.subarray(0, Math.floor(gz.length / 2)));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /not a valid gzip stream/);
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test('a dump with no CREATE TABLE is not a database dump', () => {
  const dir = goodBackup(tmp());
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('-- nothing here\n'));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /no tables/);
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test('a manifest that is not JSON fails, named', () => {
  const dir = goodBackup(tmp());
  writeFileSync(path.join(dir, 'manifest.json'), '{ not json');
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /manifest\.json is not valid JSON/);
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test('a missing manifest fails', () => {
  const dir = goodBackup(tmp());
  rmSync(path.join(dir, 'manifest.json'));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /manifest\.json missing/);
  rmSync(dir, { recursive: true, force: true });
});

test('an unreadable volume archive fails with its name', () => {
  const dir = goodBackup(tmp());
  // Valid gzip, but the tar inside ends mid-entry: a 1200-byte file cut inside
  // its body, so the entry promises more bytes than the archive holds.
  const tar = tinyTar('a.txt', 'x'.repeat(1200));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tar.subarray(0, 512 + 1100)));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /archives\.tar\.gz is unreadable/);
  assert.ok(result.checks.some(c => !c.ok && /truncated tail/.test(c.detail)), JSON.stringify(result.checks));
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test('a corrupted tar header (checksum mismatch) is unreadable', () => {
  const dir = goodBackup(tmp());
  const tar = tinyTar('a.txt', 'hello');
  tar[10] ^= 0xff; // corrupt the mode field → stored checksum no longer matches
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tar));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /unreadable/);
  rmSync(dir, { recursive: true, force: true });
});

test('a volumes/ directory with no archives is a failed backup', () => {
  const dir = goodBackup(tmp());
  rmSync(path.join(dir, 'volumes'), { recursive: true, force: true });
  mkdirSync(path.join(dir, 'volumes'));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /no archives/);
  rmSync(dir, { recursive: true, force: true });
});

test('newestBackup: the lexicographically newest timestamped directory, ignoring stray files', () => {
  const root = tmp();
  assert.equal(newestBackup(root), null);
  mkdirSync(path.join(root, '2026-11-17T09-15-04Z'));
  mkdirSync(path.join(root, '2026-11-18T00-00-00Z'));
  writeFileSync(path.join(root, 'notes.txt'), 'x');
  mkdirSync(path.join(root, 'not-a-backup'));
  assert.equal(path.basename(newestBackup(root)), '2026-11-18T00-00-00Z');
  rmSync(root, { recursive: true, force: true });
  assert.equal(newestBackup(root), null);
});

// ── The manifest is the backup's inventory: every listed volume must be here ──

test('a manifest volume without its archive fails, named, and leaves no marker', () => {
  const dir = goodBackup(tmp());
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    createdAt: '2026-11-18T00:00:00Z',
    volumes: [{ name: 'archives', mount: '/srv/archives', bytes: 1 }, { name: 'assets', mount: '/srv/assets', bytes: 1 }],
  }));
  // goodBackup wrote archives.tar.gz and lti.tar.gz — assets.tar.gz is missing.
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /assets/);
  assert.match(result.error, /without an archive/);
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test('a manifest listing volumes with no volumes/ directory at all fails, named', () => {
  const dir = goodBackup(tmp());
  rmSync(path.join(dir, 'volumes'), { recursive: true, force: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    createdAt: '2026-11-18T00:00:00Z',
    volumes: [{ name: 'archives', mount: '/srv/archives', bytes: 1 }],
  }));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /archives/);
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test('a manifest whose every listed volume is present and walkable passes', () => {
  const dir = goodBackup(tmp());
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    createdAt: '2026-11-18T00:00:00Z',
    volumes: [{ name: 'archives', mount: '/srv/archives', bytes: 1 }, { name: 'lti', mount: '/srv/lti', bytes: 1 }],
  }));
  const result = verifyBackup(dir);
  assert.equal(result.ok, true, result.error);
  assert.ok(existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

// ── Trailing bytes: a tar ends on a block boundary, or it was cut mid-write ──

test('a tar cut inside its trailing zero block fails as a truncated tail', () => {
  const dir = goodBackup(tmp());
  const tar = tinyTar('a.txt', 'hello');
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tar.subarray(0, tar.length - 100)));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /archives\.tar\.gz is unreadable/);
  assert.ok(result.checks.some(c => !c.ok && /truncated tail/.test(c.detail)), JSON.stringify(result.checks));
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

test('non-zero junk after the last full block fails as a truncated tail', () => {
  const dir = goodBackup(tmp());
  const tar = tinyTar('a.txt', 'hello');
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(Buffer.concat([tar, Buffer.from('junk')])));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some(c => !c.ok && /truncated tail/.test(c.detail)), JSON.stringify(result.checks));
  rmSync(dir, { recursive: true, force: true });
});

test('a tar ending at one zero block, or at the last entry bytes, still passes', () => {
  const dir = goodBackup(tmp());
  const tar = tinyTar('a.txt', 'hello');
  // One zero block instead of two.
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tar.subarray(0, tar.length - 512)));
  assert.equal(verifyBackup(dir).ok, true);
  // No zero blocks at all: header + body, ending exactly on a block boundary.
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tar.subarray(0, tar.length - 1024)));
  assert.equal(verifyBackup(dir).ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test('a real tar written by the system tar (pax/gnu/ustar) walks green', () => {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.error) return; // no system tar on this host — the hand-built fixtures above cover the walk
  const dir = goodBackup(tmp());
  const src = mkdtempSync(path.join(os.tmpdir(), 'vl-tarsrc-'));
  writeFileSync(path.join(src, 'object.bin'), Buffer.alloc(2048, 7));
  const out = path.join(dir, 'volumes', 'archives.tar.gz');
  // Relative output name: GNU tar reads a drive-letter colon as a remote host.
  const made = spawnSync('tar', ['czf', 'archives.tar.gz', '-C', src, '.'], { encoding: 'utf8', cwd: path.join(dir, 'volumes') });
  assert.equal(made.status, 0, made.stderr);
  assert.ok(existsSync(out));
  const result = verifyBackup(dir);
  assert.equal(result.ok, true, result.error);
  rmSync(src, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// ── P5b D7: an empty backup is not a backup — no volumes/ dir, no archives ──

test('a backup with no volumes/ directory at all fails, named, and leaves no marker', () => {
  const dir = goodBackup(tmp());
  rmSync(path.join(dir, 'volumes'), { recursive: true, force: true });
  // goodBackup's manifest carries volumes: [] — today the missing-dir bypass
  // at verify-backup.mjs:191 lets exactly this shape pass and earn the marker.
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.ok(result.error, 'the failure is named');
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)));
  rmSync(dir, { recursive: true, force: true });
});

// ── P5b D7: the module ends in a newline (POSIX text file) ──

test('verify-backup.mjs ends with a newline', () => {
  const text = readFileSync(new URL('../lib/verify-backup.mjs', import.meta.url), 'utf8');
  assert.ok(text.endsWith('\n'), 'the module must end with a trailing newline');
});

// ── Re-verification: a stale marker must not survive a failing second run ──

test('a failed re-verification removes the marker an earlier green run left', () => {
  const dir = goodBackup(tmp());
  assert.equal(verifyBackup(dir).ok, true);
  assert.ok(existsSync(path.join(dir, VERIFIED_MARKER)));
  // The dump rots after the first verification (a partial overwrite, a bad copy).
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('-- no tables anymore\n'));
  const result = verifyBackup(dir);
  assert.equal(result.ok, false);
  assert.ok(!existsSync(path.join(dir, VERIFIED_MARKER)), 'the stale verified marker must be gone');
  rmSync(dir, { recursive: true, force: true });
});
