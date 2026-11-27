// scripts/test/verify-backup-cli-errors.test.mjs
//
// HO1h AC-20 / U-9: both CLI entries — backup/verify-backup.mjs (the image)
// and scripts/lib/verify-backup.mjs (the host) — reject bad arguments with a
// usage line, name a bad --newest root, report an fs failure as one named line
// (never a stack trace), work through a symlink, and keep the good/bad exit
// codes and check lines. New file: no existing test is touched.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIS = [
  ['backup/verify-backup.mjs', path.join(ROOT, 'backup', 'verify-backup.mjs')],
  ['scripts/lib/verify-backup.mjs', path.join(ROOT, 'scripts', 'lib', 'verify-backup.mjs')],
];
const USAGE = /usage: node verify-backup\.mjs/;
const STACK = /^\s+at /m;

function run(entry, ...args) {
  const res = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
  assert.ifError(res.error);
  return res;
}

/** No line of either stream may look like a JS stack frame. */
function noStack(res) {
  for (const [stream, text] of [['stdout', res.stdout], ['stderr', res.stderr]]) {
    assert.ok(!STACK.test(text), `${stream} carries a stack frame: ${text}`);
  }
}

function tmp(prefix = 'vl-cli-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A tar with one file entry, built by hand (same shape as the stream tests). */
function tinyTar(name, content) {
  const BLOCK = 512;
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644', 100, 'latin1');
  header.write('0000000', 108, 'latin1');
  header.write('0000000', 116, 'latin1');
  header.write(`${bytes.length.toString(8).padStart(11, '0')} `, 124, 'latin1');
  header.write('00000000000 ', 136, 'latin1');
  header.write('        ', 148, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const body = Buffer.alloc(Math.ceil(bytes.length / BLOCK) * BLOCK);
  bytes.copy(body);
  return Buffer.concat([header, body, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]);
}

/** A backup that passes every check through verifyBackupStream. */
function goodBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\nCREATE TABLE t (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-25T00:00:00Z', volumes: [] }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hello')));
  return dir;
}

for (const [label, cli] of CLIS) {
  // ── DW-1.1: every dash-prefixed argument that is not --newest + a path ──
  test(`${label}: dash-prefixed arguments are usage errors (exit 2)`, () => {
    for (const args of [['-x'], ['-'], ['--bogus'], ['--newest', '-x'], ['--newest'], ['']]) {
      const res = run(cli, ...args);
      assert.equal(res.status, 2, `${JSON.stringify(args)}: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, USAGE, `${JSON.stringify(args)} must print usage`);
      noStack(res);
    }
  });

  // ── DW-1.2: --newest names the bad root and the reason, on one line ──
  test(`${label}: --newest names a missing path, a regular file and an unreadable dir`, () => {
    const root = tmp('vl-cli-newest-');
    let unreadable = null;
    try {
      const missing = path.join(root, 'no-such-root');
      let res = run(cli, '--newest', missing);
      assert.equal(res.status, 2, `${res.stdout}${res.stderr}`);
      assert.equal(res.stderr.trim().split('\n').length, 1, res.stderr);
      assert.ok(res.stderr.includes(missing), `the path must be named: ${res.stderr}`);
      assert.match(res.stderr, /no such directory/);
      noStack(res);

      const file = path.join(root, 'regular-file');
      writeFileSync(file, 'x');
      res = run(cli, '--newest', file);
      assert.equal(res.status, 2, `${res.stdout}${res.stderr}`);
      assert.equal(res.stderr.trim().split('\n').length, 1, res.stderr);
      assert.ok(res.stderr.includes(file), `the path must be named: ${res.stderr}`);
      assert.match(res.stderr, /not a directory/);
      noStack(res);

      unreadable = path.join(root, 'unreadable');
      mkdirSync(unreadable);
      // Root and Windows can read a 000 directory: the symptom is not
      // reproducible there, so return from this case rather than skip/todo.
      const posixNonRoot = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
      if (posixNonRoot) {
        try { chmodSync(unreadable, 0o000); } catch { unreadable = null; }
        if (unreadable) {
          let readable = true;
          try { accessSync(unreadable, constants.R_OK); } catch { readable = false; }
          if (!readable) {
            res = run(cli, '--newest', unreadable);
            assert.equal(res.status, 2, `${res.stdout}${res.stderr}`);
            assert.equal(res.stderr.trim().split('\n').length, 1, res.stderr);
            assert.ok(res.stderr.includes(unreadable), `the path must be named: ${res.stderr}`);
            assert.match(res.stderr, /unreadable/);
            noStack(res);
          }
        }
      }
    } finally {
      if (unreadable) {
        try { chmodSync(unreadable, 0o700); } catch { /* already gone or never locked */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── DW-1.3: an fs error during verification is named, not a stack ──
  test(`${label}: an fs error while verifying exits 1 with a named error`, () => {
    const dir = goodBackup(tmp('vl-cli-fserr-'));
    try {
      // volumes/ as a regular file makes readdirSync throw ENOTDIR inside the
      // stream verifier — a real fs error, reproducible on every platform.
      rmSync(path.join(dir, 'volumes'), { recursive: true, force: true });
      writeFileSync(path.join(dir, 'volumes'), 'not a directory');
      const res = run(cli, dir);
      assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
      assert.match(res.stdout + res.stderr, /^not verified: [A-Z]+: /m,
        `the error must be named on one line: ${res.stdout}${res.stderr}`);
      noStack(res);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── DW-1.4: a symlink to the CLI file is still the main module ──
  test(`${label}: invoked through a symlink, a good backup exits 0`, () => {
    const root = tmp('vl-cli-link-');
    try {
      const link = path.join(root, path.basename(cli));
      try {
        symlinkSync(cli, link, 'file');
      } catch (err) {
        // Symlink creation needs privileges on Windows; there is nothing to
        // assert on a host that cannot make one. Do not skip/todo.
        assert.ok(err);
        return;
      }
      const dir = goodBackup(path.join(root, 'backup'));
      const res = run(link, dir);
      assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /^verified: /m);
      noStack(res);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── DW-1.5: U-9 — exit 0/1 and the check lines are unchanged ──
  test(`${label}: a good backup is 0, a bad one 1, with the same check lines`, () => {
    const root = tmp('vl-cli-exits-');
    try {
      const goodDir = goodBackup(path.join(root, 'good'));
      let res = run(cli, goodDir);
      assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /^ok\s+db\.sql\.gz/m);
      assert.match(res.stdout, /^verified: /m);
      noStack(res);

      const badDir = goodBackup(path.join(root, 'bad'));
      rmSync(path.join(badDir, 'db.sql.gz'));
      res = run(cli, badDir);
      assert.equal(res.status, 1, `${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /^FAIL\s+db\.sql\.gz/m);
      assert.match(res.stdout, /not verified: db\.sql\.gz missing/);
      noStack(res);

      const newestRoot = path.join(root, 'newest');
      mkdirSync(newestRoot);
      const newest = goodBackup(path.join(newestRoot, '2026-11-25T12-00-00Z'));
      res = run(cli, '--newest', newestRoot);
      assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
      assert.ok(res.stdout.includes(`newest backup: ${newest}`), res.stdout);
      assert.match(res.stdout, /^verified: /m);
      noStack(res);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
