// scripts/test/selfhost-restore.test.mjs
//
// P5b D6: the restore step inside the check, over injected exec/probe. The
// sequence is pinned command by command: seed a draft proof row → backup →
// verify + marker → DELETE the row → `restore.mjs <name> --yes` inside the
// backup container with docker-compose.restore.yml's rw mounts → the row is
// back, its count matches the backup, and /api/health still answers. The
// draft is invisible to the smoke (deleted before it, restored back after).
// `node --test`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { runCheck } from '../selfhost-check.mjs';
import { VERIFIED_MARKER } from '../lib/verify-backup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_NAME = '2026-11-18T00-00-00Z';

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

function makeBackup(dir) {
  mkdirSync(path.join(dir, 'volumes'), { recursive: true });
  writeFileSync(path.join(dir, 'db.sql.gz'), gzipSync('CREATE TABLE scenarios (id int);\n'));
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: '2026-11-18T00:00:00Z' }));
  writeFileSync(path.join(dir, 'volumes', 'archives.tar.gz'), gzipSync(tinyTar('a.txt', 'hi')));
  return dir;
}

/**
 * A one-row database behind the injected docker exec. psql INSERT seeds the
 * draft proof row, the backup run snapshots the current count, DELETE removes
 * it, restore.mjs brings the snapshot back. `breakRestore` makes the restore
 * child fail; `skipDelete` leaves the row in place (the count proof must still
 * hold — restore is idempotent).
 */
function harness({ breakRestore = false } = {}) {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const calls = [];
  const events = [];
  const healthUrls = [];
  let rows = 0;
  let backedUpRows = null;
  let markerSeenAtRestore = null;
  let backupHostDir = null;

  const exec = (cmd, args, opts = {}) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('psql')) {
      const sql = args.join(' ');
      if (/insert/i.test(sql)) { rows += 1; events.push('seed'); }
      else if (/delete/i.test(sql)) { rows = 0; events.push('delete'); }
      else if (/select/i.test(sql)) { events.push('count'); return { status: 0, stdout: `${rows}\n`, stderr: '' }; }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('run')) {
      if (args.includes('restore.mjs')) {
        events.push('restore');
        // The marker gate: restore.mjs refuses a backup without `verified`,
        // so by the time the restore child runs the marker must exist.
        markerSeenAtRestore = backupHostDir ? existsSync(path.join(backupHostDir, BACKUP_NAME, VERIFIED_MARKER)) : false;
        if (breakRestore) return { status: 1, stdout: '', stderr: 'psql failed (exit 1)' };
        rows = backedUpRows ?? 0;
        return { status: 0, stdout: 'restore done\n', stderr: '' };
      }
      events.push('backup');
      const mount = args[args.indexOf('-v') + 1];
      backupHostDir = mount.slice(0, mount.lastIndexOf(':'));
      mkdirSync(backupHostDir, { recursive: true });
      makeBackup(path.join(backupHostDir, BACKUP_NAME));
      backedUpRows = rows;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'run') { events.push('smoke'); return { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' }; }
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const probe = async url => {
    healthUrls.push(url);
    return { status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } };
  };

  const cleanup = () => {
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  };
  return {
    lock, tmpRoot, calls, events, healthUrls, exec, probe, cleanup,
    rows: () => rows, backedUpRows: () => backedUpRows, markerSeenAtRestore: () => markerSeenAtRestore,
  };
}

const run = h => runCheck({
  lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: () => {}, sleep: async () => {}, probe: h.probe,
});

test('restore step: seed → backup → marker → delete → restore --yes → proof, in that order', async () => {
  const h = harness();
  try {
    const result = await run(h);
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    const restoreStep = result.steps.find(s => s.name === 'restore');
    assert.ok(restoreStep && restoreStep.ok, 'the restore step is green');

    // The event order the design pins (D6). The seed precedes the backup so
    // the snapshot holds the proof row; the delete precedes the restore so the
    // restore has something to bring back; the smoke runs last.
    const order = h.events.filter(e => ['seed', 'backup', 'delete', 'restore', 'smoke'].includes(e));
    assert.deepEqual(order, ['seed', 'backup', 'delete', 'restore', 'smoke'], h.events.join(' → '));

    // The proof row is back and its count matches what the backup held.
    assert.equal(h.rows(), 1);
    assert.equal(h.rows(), h.backedUpRows());
    // The marker existed when the restore child ran (restore.mjs' gate).
    assert.equal(h.markerSeenAtRestore(), true);
    // /api/health was probed again after the restore (the stack still answers).
    const restoreCall = h.calls.findIndex(l => l.includes('restore.mjs'));
    assert.ok(restoreCall >= 0);
    assert.ok(h.healthUrls.length >= 2, 'health probed before and after the restore');
  } finally { h.cleanup(); }
});

test('restore step: the restore child is compose run with restore.yml rw mounts, --entrypoint node, --yes', async () => {
  const h = harness();
  try {
    const result = await run(h);
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    const restoreLine = h.calls.find(l => l.includes('restore.mjs'));
    assert.ok(restoreLine, 'a restore child ran');
    assert.ok(restoreLine.startsWith('docker compose '), restoreLine);
    assert.ok(restoreLine.includes('-f docker-compose.yml'), 'base compose file');
    assert.ok(restoreLine.includes('-f docker-compose.selfcheck.yml'),
      'the check stack’s renamed volumes — without the selfcheck overlay the restore would write the LIVE stack’s volumes');
    assert.ok(restoreLine.includes('-f docker-compose.restore.yml'), 'the rw-mount overlay');
    assert.ok(restoreLine.includes('run --rm'), restoreLine);
    assert.ok(restoreLine.includes('--entrypoint node'), 'restore.mjs runs under node, not the backup entrypoint');
    assert.ok(restoreLine.includes('-e BACKUP_DIR=/backups'), restoreLine);
    assert.ok(restoreLine.includes(`restore.mjs ${BACKUP_NAME} --yes`), `the verified backup by name, with --yes: ${restoreLine}`);
    assert.ok(restoreLine.includes(' backup '), 'the backup service');
    // The backup directory is mounted into the restore child too.
    assert.ok(/-v \S+:\/backups/.test(restoreLine), restoreLine);
  } finally { h.cleanup(); }
});

test('restore step: the seed/delete/count psql children run inside the stack, never on the host', async () => {
  const h = harness();
  try {
    const result = await run(h);
    assert.equal(result.ok, true, `failed at ${result.failed}`);
    const psqlLines = h.calls.filter(l => l.includes('psql'));
    assert.ok(psqlLines.length >= 3, `seed + delete + count: ${psqlLines.join('\n')}`);
    for (const line of psqlLines) {
      assert.ok(line.startsWith('docker '), `psql ran on the host: ${line}`);
      assert.ok(line.includes('exec') || line.includes('run'), line);
      assert.ok(line.includes('database'), 'against the stack database service');
    }
    // The proof row is a draft — invisible to the smoke's public catalog.
    const seed = psqlLines.find(l => /insert/i.test(l));
    assert.match(seed, /draft/i);
    assert.match(seed, /scenarios/i);
  } finally { h.cleanup(); }
});

test('restore step: a failed restore is a named failure, teardown still runs, smoke never starts', async () => {
  const h = harness({ breakRestore: true });
  try {
    const result = await run(h);
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'restore');
    assert.ok(!h.events.includes('smoke'), 'the smoke must not run after a failed restore');
    assert.ok(h.calls.some(l => l.includes('down -v')), 'teardown ran');
    assert.deepEqual((await import('node:fs')).readdirSync(h.tmpRoot), [], 'temp tree removed');
  } finally { h.cleanup(); }
});
