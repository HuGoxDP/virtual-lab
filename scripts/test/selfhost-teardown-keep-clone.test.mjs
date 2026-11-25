// scripts/test/selfhost-teardown-keep-clone.test.mjs
//
// HO1f3: when the teardown `down` command fails, the clone must be kept so the
// printed `cd <workdir>/app` manual command points at a directory that exists.
// NEW file — existing tests stay untouched. `node --test`.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { runCheck } from '../selfhost-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(path.join(HERE, '..', '..', '.env.example'), 'utf8');

/** A tar with one file entry; verify-backup only needs valid headers. */
function tinyTar(name, content) {
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644', 100, 'latin1');
  header.write('0000000', 108, 'latin1');
  header.write('0000000', 116, 'latin1');
  header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 'latin1');
  header.write('00000000000 ', 148, 'latin1');
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
 * A fake child layer that drives runCheck through a full green run without
 * Docker, git or a network (the same seam as selfhost-teardown-report.test.mjs,
 * copied here rather than imported so the existing file stays untouched).
 * `downStatus` makes the teardown `down` fail on an otherwise green run.
 */
function harness(overrides = {}) {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const lines = [];
  let rows = 0;
  let backedUpRows = null;
  const fns = {
    downStatus: 0,
    updateStatus: 0,
    upStatus: 0,
    healthOk: true,
    smoke: { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' },
    ...overrides,
  };
  const exec = (cmd, args, opts = {}) => {
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), TEMPLATE);
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
      makeBackup(path.join(hostDir, '2026-11-18T00-00-00Z'));
      backedUpRows = rows;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('logs')) {
      // The log tail is only read on a failed up/health, which a green harness
      // never reaches; an empty tail keeps the seam total.
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'docker' && args.includes('update')) return { status: fns.updateStatus, stdout: '', stderr: '' };
    if (cmd === 'docker' && args.includes('down')) return { status: fns.downStatus, stdout: '', stderr: '' };
    if (cmd === 'docker' && args.includes('up')) return { status: fns.upStatus, stdout: '', stderr: 'up failed' };
    if (cmd === 'npm' && args[0] === 'run' && args.includes('smoke')) return fns.smoke;
    if (cmd === 'npm' || cmd === 'npx') return { status: 0, stdout: 'up to date\n', stderr: '' };
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };
  const probe = async () => ({
    status: fns.healthOk ? 200 : 503,
    body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } },
  });
  const log = line => lines.push(line);
  const run = extra => runCheck({ lock, tmpRoot, exec, git: exec, log, sleep: async () => {}, probe, ...extra });
  const cleanup = () => {
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  };
  return { lock, tmpRoot, lines, exec, probe, log, run, cleanup, fns };
}

/** Parse the clone dir out of the pinned manual command's `cd <dir> &&` prefix. */
function cloneDirFromLog(lines) {
  const line = lines.find(l => l.includes('clean up by hand:') && l.includes('cd ') && l.includes(' && docker'));
  assert.ok(line, 'the manual teardown command was printed');
  const m = line.match(/clean up by hand: cd (.+?) && docker /);
  assert.ok(m, 'the manual command has the `cd <cloneDir> && docker` shape');
  return m[1];
}

// ---- HO1f3: keep the clone when `down` fails ----

test('HO1f3: a failed down keeps the clone and prints `kept` before the manual command', async () => {
  const h = harness({ downStatus: 1 });
  try {
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'teardown');

    const cloneDir = cloneDirFromLog(h.lines);
    // The `cd <workdir>/app` in the printed command must actually exist.
    assert.ok(existsSync(cloneDir), `the kept clone dir must exist: ${cloneDir}`);

    const workdir = path.dirname(cloneDir);
    assert.ok(h.lines.includes(`  --   kept ${workdir}`), `a kept line naming ${workdir} was logged`);

    const keptIdx = h.lines.indexOf(`  --   kept ${workdir}`);
    const handIdx = h.lines.findIndex(l => l.includes('clean up by hand:'));
    assert.ok(keptIdx < handIdx, 'the kept line precedes the clean up by hand line');

    const teardown = result.steps.find(s => s.name === 'teardown');
    assert.equal(teardown.ok, false);
    assert.match(teardown.detail, /exited 1/);
  } finally { h.cleanup(); }
});

test('HO1f3: a green run still removes the workdir (temp root empty)', async () => {
  const h = harness();
  try {
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.failed, undefined);
    assert.deepEqual(readdirSync(h.tmpRoot), [], 'a green down still removes the workdir');
    assert.ok(!h.lines.some(l => l.includes('kept ') && l.includes(h.tmpRoot)), 'no kept line on a green run');
  } finally { h.cleanup(); }
});
