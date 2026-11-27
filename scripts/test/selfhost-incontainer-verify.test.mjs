// scripts/test/selfhost-incontainer-verify.test.mjs
//
// HO1b2 (MS-2, AC-17, U-8): the opt-in `--verify-in-container` replaces the
// host verifier with one compose child whose exit status decides the `backup`
// step. These tests drive `runCheck` through injected exec/git/probe (no
// Docker, no git, no network) and spawn the CLI with process.execPath without
// --lock (no Docker is touched). `node --test`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { COMPOSE_INTERPOLATED, containerVerifyArgs, parseArgs, runCheck } from '../selfhost-check.mjs';
import { VERIFIED_MARKER } from '../lib/verify-backup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'selfhost-check.mjs');
const BACKUP_NAME = '2026-11-23T00-00-00Z';

/** One file entry tar with a valid checksum — the verifier needs headers only. */
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
  Buffer.from(content).copy(body);
  return Buffer.concat([header, body, Buffer.alloc(BLOCK), Buffer.alloc(BLOCK)]);
}

/** `invalid: true` makes db.sql.gz non-gzip: the host verifier would refuse it. */
function writeBackup(dir, { invalid = false } = {}) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'),
    invalid ? Buffer.from('not a gzip stream\n') : gzipSync('CREATE TABLE scenarios (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-23T00:00:00Z' }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hi')));
}

/**
 * A green run over fake children. `verifyMode` decides what the in-container
 * verifier does: green (status 0 + marker), no-marker (status 0, no marker),
 * fail (status 1 with a verifier message), spawn-fail (status null + error),
 * abort (aborts the injected controller, then status 130).
 */
function harness({ verifyMode = 'green', invalidHostBackup = false, controller = null } = {}) {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const calls = [];
  const lines = [];
  let rows = 0;
  let backedUpRows = null;
  let backupHostDir = null;
  let verifyIndex = -1;
  let verifyArgs = null;
  let verifyOpts = null;
  let cloneDir = null;

  const exec = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts, line: [cmd, ...args].join(' ') });
    if (cmd === 'git' && args[0] === 'clone') {
      cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('psql')) {
      const sql = args.join(' ');
      if (/insert/i.test(sql)) rows += 1;
      else if (/delete/i.test(sql)) rows = 0;
      else if (/select/i.test(sql)) return { status: 0, stdout: `${rows}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('run')) {
      if (args.includes('verify-backup.mjs')) {
        verifyIndex = calls.length - 1;
        verifyArgs = args;
        verifyOpts = opts;
        if (verifyMode === 'abort') {
          controller?.abort();
          return { status: 130, stdout: '', stderr: '' };
        }
        if (verifyMode === 'fail') {
          return { status: 1, stdout: 'not verified: volume archive archives.tar.gz is unreadable\n', stderr: '' };
        }
        if (verifyMode === 'spawn-fail') {
          return { status: null, stdout: '', stderr: '', error: new Error('spawn docker ENOENT') };
        }
        if (verifyMode === 'no-marker') {
          return { status: 0, stdout: `newest backup: ${BACKUP_NAME}\n`, stderr: '' };
        }
        writeFileSync(path.join(backupHostDir, BACKUP_NAME, VERIFIED_MARKER), '');
        return { status: 0, stdout: `newest backup: ${BACKUP_NAME}\n`, stderr: '' };
      }
      if (args.includes('restore.mjs')) {
        rows = backedUpRows ?? 0;
        return { status: 0, stdout: 'restore done\n', stderr: '' };
      }
      const mount = args[args.indexOf('-v') + 1];
      backupHostDir = mount.slice(0, mount.lastIndexOf(':'));
      writeBackup(path.join(backupHostDir, BACKUP_NAME), { invalid: invalidHostBackup });
      backedUpRows = rows;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'run') return { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' };
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const probe = async () => ({ status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } });
  const cleanup = () => {
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  };
  return {
    lock, tmpRoot, calls, exec, probe, cleanup,
    log: line => lines.push(line), lines,
    cloneDir: () => cloneDir, backupHostDir: () => backupHostDir,
    verifyIndex: () => verifyIndex, verifyArgs: () => verifyArgs, verifyOpts: () => verifyOpts,
  };
}

const run = (h, extra = {}) => runCheck({
  lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log,
  sleep: async () => {}, probe: h.probe, ...extra,
});

// ── DW-1.1: parseArgs — additive key, absent by default ──

test('DW-1.1 parseArgs: the flag is a key only when given, and unknown forms are refused', () => {
  assert.equal(parseArgs(['--verify-in-container']).verifyInContainer, true);
  assert.equal('verifyInContainer' in parseArgs([]), false, 'the default object must have no new key');
  const mixed = parseArgs(['--https', '--verify-in-container', '--lock', '/l']);
  assert.equal(mixed.https, true);
  assert.equal(mixed.verifyInContainer, true);
  assert.equal(mixed.lock, '/l');
  assert.throws(() => parseArgs(['--verify-in-container=yes']), /unknown argument/);
});

// ── DW-1.2: containerVerifyArgs — the exact compose child, both https modes ──

test('DW-1.2 containerVerifyArgs: the exact args in plain and https mode', () => {
  const plain = containerVerifyArgs('/h/b');
  assert.deepEqual(plain, ['compose', '-p', 'vl-selfcheck',
    '-f', 'docker-compose.yml', '-f', 'docker-compose.selfcheck.yml',
    'run', '--rm', '--entrypoint', 'node', '-e', 'BACKUP_DIR=/backups',
    '-v', '/h/b:/backups', 'backup', 'verify-backup.mjs', '--newest', '/backups']);
  const https = containerVerifyArgs('/h/b', { https: true });
  assert.deepEqual(https, ['compose', '-p', 'vl-selfcheck',
    '-f', 'docker-compose.yml', '-f', 'docker-compose.selfcheck.yml', '-f', 'docker-compose.https.yml',
    'run', '--rm', '--entrypoint', 'node', '-e', 'BACKUP_DIR=/backups',
    '-v', '/h/b:/backups', 'backup', 'verify-backup.mjs', '--newest', '/backups']);
  const joined = plain.join(' ');
  assert.ok(joined.includes('--entrypoint node'), joined);
  assert.ok(joined.includes('-e BACKUP_DIR=/backups'), joined);
  assert.ok(joined.includes('verify-backup.mjs --newest /backups'), joined);
  assert.ok(https.indexOf('-f docker-compose.https.yml') < https.indexOf('run'),
    'the https overlay comes before the compose subcommand');
});

// ── DW-1.3: the child, its args/cwd/env, and unchanged step names ──

test('DW-1.3 in-container run: one verify child, exact args, clone cwd, scrubbed env, same steps', async () => {
  const savedBackupDir = process.env.BACKUP_DIR;
  const savedDbPassword = process.env.DB_PASSWORD;
  process.env.BACKUP_DIR = '/exported/host-backups';
  process.env.DB_PASSWORD = 'exported-password';
  const h = harness();
  const plain = harness();
  try {
    const result = await run(h, { verifyInContainer: true });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    const verifyCalls = h.calls.filter(c => c.line.includes('verify-backup.mjs'));
    assert.equal(verifyCalls.length, 1, 'exactly one verify child');
    const call = verifyCalls[0];
    assert.deepEqual(call.args, containerVerifyArgs(h.backupHostDir()), 'the child carries the host mount');
    assert.equal(call.opts.cwd, h.cloneDir(), 'the child runs in the clone dir');
    for (const name of COMPOSE_INTERPOLATED) {
      assert.equal(name in (call.opts.env ?? {}), false, `${name} reached the docker child`);
    }
    const baseline = await run(plain);
    assert.equal(baseline.ok, true, `baseline failed at ${baseline.failed}`);
    // The step names are identical between the two modes (U-8's step list).
    assert.deepEqual(result.steps.map(s => s.name), baseline.steps.map(s => s.name));
    assert.equal(result.steps.find(s => s.name === 'backup').detail,
      `verified in the backup container, ${BACKUP_NAME}`);
  } finally {
    if (savedBackupDir === undefined) delete process.env.BACKUP_DIR; else process.env.BACKUP_DIR = savedBackupDir;
    if (savedDbPassword === undefined) delete process.env.DB_PASSWORD; else process.env.DB_PASSWORD = savedDbPassword;
    h.cleanup();
    plain.cleanup();
  }
});

// ── DW-1.4: the host verifier is not consulted; marker is read on the host mount ──

test('DW-1.4 an invalid host backup still passes when the container verifies it', async () => {
  const h = harness({ invalidHostBackup: true });
  try {
    const result = await run(h, { verifyInContainer: true });
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    assert.equal(result.steps.find(s => s.name === 'backup').ok, true);
    assert.equal(result.steps.find(s => s.name === 'backup marker').ok, true);
  } finally { h.cleanup(); }
});

test('DW-1.4 exit 0 without a marker on the host mount fails at backup marker', async () => {
  const h = harness({ verifyMode: 'no-marker' });
  try {
    const result = await run(h, { verifyInContainer: true });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'backup marker');
    const markerStep = result.steps.find(s => s.name === 'backup marker');
    assert.equal(markerStep.detail, 'missing');
    assert.equal(result.steps.find(s => s.name === 'backup').ok, true, 'the child itself was green');
  } finally { h.cleanup(); }
});

// ── DW-1.5: non-zero / spawn failure — RED at backup, tail, teardown ──

test('DW-1.5 a non-zero child is RED at backup with its output tail; teardown follows', async () => {
  const h = harness({ verifyMode: 'fail' });
  try {
    const result = await run(h, { verifyInContainer: true });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'backup');
    const backupStep = result.steps.find(s => s.name === 'backup');
    assert.equal(backupStep.ok, false);
    assert.match(backupStep.detail, /volume archive archives\.tar\.gz is unreadable/);
    assert.equal(h.calls.some(c => c.line.includes('restore.mjs')), false, 'no restore after a failed verify');
    const idx = h.verifyIndex();
    const update = h.calls.findIndex(c => c.line.includes('docker update --restart=no'));
    const down = h.calls.findIndex(c => c.line.includes('down -v'));
    assert.ok(idx >= 0 && update > idx && down > idx, 'teardown children come after the verify child');
  } finally { h.cleanup(); }
});

test('DW-1.5 a spawn failure (status null) names its error in the backup detail', async () => {
  const h = harness({ verifyMode: 'spawn-fail' });
  try {
    const result = await run(h, { verifyInContainer: true });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'backup');
    assert.match(result.steps.find(s => s.name === 'backup').detail, /ENOENT/);
    assert.ok(h.calls.some(c => c.line.includes('down -v')), 'teardown still runs');
  } finally { h.cleanup(); }
});

// ── DW-1.6: abort during the child is interrupted, with teardown ──

test('DW-1.6 an abort observed at the child is RED at interrupted, with teardown', async () => {
  const controller = new AbortController();
  const h = harness({ verifyMode: 'abort', controller });
  try {
    const result = await run(h, { verifyInContainer: true, signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'interrupted');
    assert.ok(h.verifyIndex() >= 0, 'the child really ran');
    assert.ok(h.calls.some(c => c.line.includes('docker update --restart=no')));
    assert.ok(h.calls.some(c => c.line.includes('down -v')));
  } finally { h.cleanup(); }
});

// ── DW-1.7 / U-8: an absent option and an explicit false are the base run ──

test('DW-1.7 U-8: absent option and verifyInContainer:false are identical to the base', async () => {
  const absent = harness();
  const explicitFalse = harness();
  try {
    const a = await run(absent);
    const b = await run(explicitFalse, { verifyInContainer: false });
    const norm = (s, h) => {
      // Each run gets a fresh mkdtemp name — replace the workdir first, then
      // its parent and the lock, exactly as the plan's U-8 comparison asks.
      let out = h.cloneDir() ? s.split(path.dirname(h.cloneDir())).join('<WORKDIR>') : s;
      return out.split(h.tmpRoot).join('<TMP>').split(h.lock).join('<LOCK>');
    };
    const linesOf = h => h.calls.map(c => norm(c.line, h));
    assert.equal(a.ok, true, `absent failed at ${a.failed}`);
    assert.equal(b.ok, true, `false failed at ${b.failed}`);
    assert.deepEqual(linesOf(absent), linesOf(explicitFalse), 'every docker/git command is identical');
    assert.deepEqual(linesOf(absent).filter(l => l.includes('verify-backup.mjs')), [], 'no verify child');
    const stepsOf = r => r.steps.map(s => [s.name, s.ok, s.detail]);
    assert.deepEqual(stepsOf(a).map(x => [x[0], x[1], norm(x[2], absent)]),
      stepsOf(b).map(x => [x[0], x[1], norm(x[2], explicitFalse)]), 'step names and details are identical');
  } finally { absent.cleanup(); explicitFalse.cleanup(); }
});

// ── DW-1.8: the CLI (no --lock, so no Docker is touched) ──

test('DW-1.8 CLI: the flag is announced and --help lists it', () => {
  const flagged = spawnSync(process.execPath, [SCRIPT, '--verify-in-container'], { encoding: 'utf8' });
  assert.ifError(flagged.error);
  assert.equal(flagged.status, 1);
  assert.match(flagged.stdout, /verify=container/);
  assert.match(flagged.stdout, /RED at lock/);
  const plain = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.ifError(plain.error);
  assert.equal(plain.status, 1);
  assert.doesNotMatch(plain.stdout, /verify=/, 'the default start line is unchanged');
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--verify-in-container/);
});
