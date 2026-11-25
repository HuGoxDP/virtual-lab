// scripts/test/selfhost-teardown-report.test.mjs
//
// HO1f Phase 3 (D6, D7, D8): honest teardown, redacted backend log tail and
// actionable smoke-failure detail. NEW file — existing tests stay untouched.
// `node --test`.

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
 * Docker, git or a network. The `logs` child emits the two generated secrets
 * so D7's redaction is provable rather than assumed.
 */
function harness(overrides = {}) {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const lines = [];
  const seen = [];
  let rows = 0;
  let backedUpRows = null;
  let cloneDir = null;
  const fns = {
    downStatus: 0,
    updateStatus: 0,
    upStatus: 0,
    healthOk: true,
    smoke: { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' },
    ...overrides,
  };
  const exec = (cmd, args, opts = {}) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      cloneDir = args[args.length - 1];
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
      const envText = readFileSync(path.join(cloneDir, '.env'), 'utf8');
      const dbPwd = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1] ?? '';
      const adminTok = envText.match(/^ADMIN_TOKEN=(.*)$/m)?.[1] ?? '';
      assert.ok(dbPwd && adminTok, 'the generated .env must hold both secrets');
      // Both secrets on one line; per-line redaction must catch both.
      return {
        status: 0,
        stdout: `backend db=${dbPwd} admin=${adminTok}\nsecond line ${dbPwd}\n`,
        stderr: `stderr ${adminTok}\n`,
      };
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
  return { lock, tmpRoot, lines, seen, exec, probe, log, run, cleanup, fns };
}

const GREEN_STEPS = [
  'lock', 'port', 'clone', 'env', 'up', 'healthy', 'backup', 'backup marker', 'restore', 'e2e deps', 'e2e browser', 'smoke',
];

// ---- DW-3.1 / DW-3.1b ----

test('D6: a failed down on a green run is a teardown failure with the manual command', async () => {
  const h = harness({ downStatus: 1 });
  try {
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'teardown');
    assert.equal(result.steps.filter(s => s.name === 'teardown').length, 1);
    assert.ok(!h.lines.some(l => l === '  ok   teardown'), 'a failed teardown must not print ok teardown');
    assert.ok(h.lines.some(l => l.includes('FAIL teardown')));
    assert.ok(h.lines.some(l => l.includes('clean up by hand:') && l.includes('docker compose')));
    assert.deepEqual(result.steps.slice(0, 12).map(s => s.name), GREEN_STEPS);
  } finally { h.cleanup(); }
});

test('D6: an already failed run keeps its first failed name and gains a teardown step', async () => {
  const h = harness({ downStatus: 1, smoke: { status: 1, stdout: '1 failed\n', stderr: '' } });
  try {
    const result = await h.run();
    assert.equal(result.failed, 'smoke');
    assert.equal(result.ok, false);
    assert.equal(result.steps.filter(s => s.name === 'teardown').length, 1);
    assert.ok(h.lines.some(l => l.includes('FAIL teardown')));
  } finally { h.cleanup(); }
});

test('D6: only docker update failing stays green with no teardown step', async () => {
  const h = harness({ updateStatus: 1 });
  try {
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(result.failed, undefined);
    assert.ok(!result.steps.some(s => s.name === 'teardown'));
    assert.deepEqual(result.steps.map(s => s.name), GREEN_STEPS);
  } finally { h.cleanup(); }
});

test('D6: a green teardown adds no step and removes the temp tree', async () => {
  const h = harness();
  try {
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.deepEqual(result.steps.map(s => s.name), GREEN_STEPS);
    assert.ok(h.lines.includes('  ok   teardown'));
    assert.deepEqual(readdirSync(h.tmpRoot), [], 'the temp clone dir is removed');
  } finally { h.cleanup(); }
});

test('D6: an injected removeDir throwing EBUSY is reported as teardown, not swallowed', async () => {
  const h = harness();
  let called = 0;
  try {
    const result = await h.run({
      removeDir: () => { called += 1; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); },
    });
    assert.equal(called, 1, 'the injected remover was actually used');
    assert.equal(result.ok, false);
    assert.equal(result.failed, 'teardown');
    assert.ok(result.steps.some(s => s.name === 'teardown' && s.ok === false));
    assert.ok(h.lines.some(l => l.includes('FAIL teardown')));
    assert.ok(h.lines.some(l => l.includes('clean up by hand:')));
  } finally { h.cleanup(); }
});

test('D6: --keep on a failed up keeps the tree but tears nothing down', async () => {
  const h = harness({ upStatus: 1 });
  try {
    const result = await h.run({ keep: true });
    assert.equal(result.failed, 'up');
    assert.ok(h.lines.some(l => l.includes('kept ') && l.includes(h.tmpRoot)));
    assert.ok(!h.seen.some(l => l.includes('down -v')), '--keep must not run down -v');
    assert.ok(!h.seen.some(l => l.includes('docker update')), '--keep must not run docker update');
    assert.ok(existsSync(h.tmpRoot));
  } finally { h.cleanup(); }
});

// ---- DW-3.3 ----

test('D7: a failed health dumps the backend tail with both secrets redacted', async () => {
  const h = harness({ healthOk: false });
  try {
    const result = await h.run({ healthTimeoutMs: 0 });
    assert.equal(result.failed, 'healthy');
    assert.ok(h.lines.some(l => l.includes('backend db=') && l.includes('***')));
    assert.ok(h.lines.some(l => l.includes('second line')));
    assert.ok(h.lines.some(l => l.includes('stderr')));
    assert.ok(h.lines.filter(l => l.includes('***')).length >= 3, 'stdout + stderr lines are all redacted');
    // The real generated secrets must not appear in any logged line.
    const envPath = path.join(h.tmpRoot, 'app', '.env');
    if (existsSync(envPath)) {
      const envText = readFileSync(envPath, 'utf8');
      const dbPwd = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1] ?? '';
      const adminTok = envText.match(/^ADMIN_TOKEN=(.*)$/m)?.[1] ?? '';
      assert.ok(dbPwd && adminTok);
      assert.ok(!h.lines.some(l => l.includes(dbPwd) || l.includes(adminTok)));
    }
  } finally { h.cleanup(); }
});

test('D7: a failed up also dumps the redacted backend tail', async () => {
  const h = harness({ upStatus: 1 });
  try {
    const result = await h.run();
    assert.equal(result.failed, 'up');
    assert.ok(h.lines.some(l => l.includes('backend db=') && l.includes('***')));
    assert.ok(h.lines.filter(l => l.includes('***')).length >= 3);
  } finally { h.cleanup(); }
});

// ---- DW-3.4 ----

test('D8: smoke detail names the failing Playwright test title', async () => {
  const h = harness({ smoke: {
    status: 1,
    stdout: 'Running 7 tests\n1) [chromium] › e2e/tests/smoke.spec.ts:12:3 › opens the start page\n7 passed, 1 failed (3.1s)\n',
    stderr: '',
  } });
  try {
    const result = await h.run();
    assert.equal(result.failed, 'smoke');
    const smoke = result.steps.find(s => s.name === 'smoke');
    assert.match(smoke.detail, /opens the start page/);
    assert.match(smoke.detail, /1 failed/);
  } finally { h.cleanup(); }
});

test('D8: smoke falls back to ✘ lines and then to the raw reason', async () => {
  const h1 = harness({ smoke: { status: 1, stdout: '✘ catalog filter\n', stderr: '' } });
  try {
    const r1 = await h1.run();
    assert.match(r1.steps.find(s => s.name === 'smoke').detail, /catalog filter/);
  } finally { h1.cleanup(); }
  const h2 = harness({ smoke: { status: 1, stdout: '7 passed (1.0s)\n', stderr: 'exit 1\n' } });
  try {
    const r2 = await h2.run();
    assert.match(r2.steps.find(s => s.name === 'smoke').detail, /exit 1/);
  } finally { h2.cleanup(); }
});
