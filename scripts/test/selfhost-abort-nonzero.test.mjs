// scripts/test/selfhost-abort-nonzero.test.mjs
//
// HO1d (MS-1, AC-12): Ctrl+C tears the check down, a second Ctrl+C stops at
// once. D3 - runCheck({signal}) yields between steps and observes the abort
// (yield-then-check); an abort ends {ok:false, failed:'interrupted'} and the
// normal teardown runs; waitHealthy stops mid-sleep, never waiting out its
// timeout. D4 - installSignalHandlers: first signal aborts + one line, second
// prints the manual command and exit(130); SIGBREAK only on win32. D5 -
// manualTeardownCommand is the exact `cd ... && docker compose -p vl-selfcheck
// ... down -v --remove-orphans`; --keep still wins on abort and prints it.
// D14 - the docs teach Ctrl+C and the manual command. `node --test`, fake
// exec/git/probe/sleep - no Docker, no network, no real signals.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  composeArgs, installSignalHandlers, manualTeardownCommand, runCheck, waitHealthy,
} from '../selfhost-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');

/** Same hand-built tar as selfhost-check.test.mjs: headers with valid checksums. */
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

/** A backup directory that passes verifyBackup (same shape as the green-run tests). */
function makeBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-23T00:00:00Z' }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hi')));
  return dir;
}

/**
 * The green-run harness (same shape as selfhost-check.test.mjs), plus an
 * `onCall` hook fired on every exec - a test aborts the signal from inside it,
 * the way a real Ctrl+C lands while a child is running.
 */
function harness({ onCall = () => {}, override = () => null } = {}) {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const seen = [];
  const lines = [];
  let rows = 0;
  let backedUpRows = null;

  const exec = (cmd, args, opts = {}) => {
    const line = [cmd, ...args].join(' ');
    seen.push(line);
    onCall(line);
    const forced = override(line);
    if (forced) return forced;
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8'));
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
      if (args.includes('restore.mjs')) { rows = backedUpRows ?? 0; return { status: 0, stdout: 'restore done\n', stderr: '' }; }
      const mount = args[args.indexOf('-v') + 1];
      const hostDir = mount.slice(0, mount.lastIndexOf(':'));
      mkdirSync(hostDir, { recursive: true });
      makeBackup(path.join(hostDir, '2026-11-23T00-00-00Z'));
      backedUpRows = rows;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'run') return { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' };
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const probe = async () => ({ status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } });
  const log = l => lines.push(l);
  const cleanup = () => {
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  };
  return { lock, tmpRoot, seen, lines, exec, probe, log, cleanup };
}

// -- AC-12: a real Ctrl+C reaches the child, so the child returns non-zero --
// The fake exec aborts the controller AND makes that same child return the way
// a terminal SIGINT leaves it: status 130, or status null with signal SIGINT.

async function interruptedRun({ abortOn, result }) {
  const controller = new AbortController();
  const h = harness({
    onCall: line => { if (line.includes(abortOn)) controller.abort(); },
    override: line => (line.includes(abortOn) ? result : null),
  });
  try {
    const run = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: h.log, sleep: async () => {},
      probe: h.probe, signal: controller.signal,
    });
    // Snapshot before cleanup: h.cleanup() removes the tmpRoot itself, so
    // asserting on the path afterwards would see ENOENT, not the check's work.
    return { run, h, tmpEntries: readdirSync(h.tmpRoot) };
  } finally { h.cleanup(); }
}

test('an abort + status 130 during up ends interrupted, with teardown (AC-12)', async () => {
  const { run, h, tmpEntries } = await interruptedRun({ abortOn: ' up -d --build', result: { status: 130, stdout: '', stderr: '' } });
  assert.equal(run.failed, 'interrupted');
  assert.ok(run.steps.some(s => s.name === 'up'), 'the up attempt is still recorded');
  assert.equal(h.seen.filter(l => l.startsWith('docker update') || l.includes('down -v')).length, 2, 'both teardown commands run');
  assert.deepEqual(tmpEntries, []);
});

test('an abort + status null, signal SIGINT during up ends interrupted (AC-12)', async () => {
  const { run, h, tmpEntries } = await interruptedRun({
    abortOn: ' up -d --build', result: { status: null, signal: 'SIGINT', stdout: '', stderr: '' },
  });
  assert.equal(run.failed, 'interrupted');
  assert.equal(h.seen.filter(l => l.startsWith('docker update') || l.includes('down -v')).length, 2);
  assert.deepEqual(tmpEntries, []);
});

test('an abort + status 130 during the clone ends interrupted, no up, temp dir gone (AC-12)', async () => {
  const { run, h, tmpEntries } = await interruptedRun({ abortOn: 'git clone', result: { status: 130, stdout: '', stderr: '' } });
  assert.equal(run.failed, 'interrupted');
  assert.ok(!h.seen.some(l => l.includes(' up -d --build')), 'nothing was started');
  assert.ok(!h.seen.some(l => l.startsWith('docker update') || l.includes('down -v')), 'no teardown - no stack');
  assert.deepEqual(tmpEntries, [], 'the temp tree is removed');
});
