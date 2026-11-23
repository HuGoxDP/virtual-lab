// scripts/test/selfhost-run-command.test.mjs
//
// HO1c (MS-1, AC-11): the default command runner and the failure detail.
// D1 — on Windows npm/npx run through this node itself (npm-cli.js/npx-cli.js),
// so `runCommand('npm', ['--version'])` works even when PATH holds only the
// directory of process.execPath; a pnpm/yarn npm_execpath is ignored; a missing
// npm-cli degrades to a named ENOENT, never a crash. D2 — one why() helper:
// every failing command step (up, backup, restore, e2e deps, e2e browser,
// smoke) carries the spawn error's message plus the output tail. `node --test`.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { runCommand, runCheck, why } from '../selfhost-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');
const IS_WIN = process.platform === 'win32';

// ── DW-1.1: npm/npx via node on Windows, with a PATH of only node's directory ──

test('runCommand: npm --version on Windows succeeds with PATH = only dirname(execPath) (DW-1.1)', () => {
  if (!IS_WIN) return; // off Windows the shim problem does not exist
  const res = runCommand('npm', ['--version'], { env: { ...process.env, PATH: path.dirname(process.execPath) } });
  assert.equal(res.error, undefined, String(res.error));
  assert.equal(res.status, 0);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('runCommand: npx --version on Windows succeeds with PATH = only dirname(execPath) (DW-1.1)', () => {
  if (!IS_WIN) return;
  const res = runCommand('npx', ['--version'], { env: { ...process.env, PATH: path.dirname(process.execPath) } });
  assert.equal(res.error, undefined, String(res.error));
  assert.equal(res.status, 0);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
});

// ── runCommand unit contract: never throws, opts forwarded, non-npm untouched ──

test('runCommand: a missing command is {status: null, error: ENOENT}, never a throw', () => {
  const res = runCommand('vl-no-such-command-ho1c', ['--version']);
  assert.equal(res.status, null);
  assert.ok(res.error, 'a spawn failure must surface as res.error');
  assert.match(res.error.message, /ENOENT/);
  assert.equal(typeof res.stdout, 'string');
  assert.equal(typeof res.stderr, 'string');
});

test('runCommand: opts (cwd, env) reach the child; non-npm commands run unchanged', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vl-runcmd-'));
  try {
    const res = runCommand(process.execPath, ['-p', 'process.cwd()'], { cwd: dir });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), realpathSync(dir));
    const env = runCommand(process.execPath, ['-p', 'process.env.HO1C_MARKER'], { env: { ...process.env, HO1C_MARKER: 'forwarded' } });
    assert.equal(env.stdout.trim(), 'forwarded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runCommand: npm_execpath pointing at yarn is ignored — the bundled npm-cli wins (Windows)', () => {
  if (!IS_WIN) return;
  const saved = process.env.npm_execpath;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vl-yarn-'));
  try {
    const yarn = path.join(dir, 'yarn.js');
    writeFileSync(yarn, 'process.exit(97);');
    process.env.npm_execpath = yarn;
    const res = runCommand('npm', ['--version'], { env: { ...process.env, PATH: path.dirname(process.execPath), npm_execpath: yarn } });
    assert.equal(res.status, 0, 'the yarn.js execpath must not be executed');
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally {
    if (saved === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand: npm-cli nowhere to be found → plain spawn → named ENOENT, no crash (Windows)', () => {
  if (!IS_WIN) return;
  const savedExecPath = process.execPath;
  const savedExecpath = process.env.npm_execpath;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vl-nonode-'));
  try {
    // A fake node directory with no node_modules/npm and a pnpm execpath: both
    // lookup candidates miss, so the plain `npm` is spawned against a PATH that
    // holds only that directory — the .cmd shim cannot run without a shell and
    // ENOENT comes back on res.error.
    process.execPath = path.join(dir, 'node.exe');
    process.env.npm_execpath = path.join(dir, 'pnpm.cjs');
    const res = runCommand('npm', ['--version'], { env: { ...process.env, PATH: dir, npm_execpath: process.env.npm_execpath } });
    assert.equal(res.status, null);
    assert.ok(res.error, 'the failure is returned, not thrown');
    assert.match(res.error.message, /ENOENT/);
  } finally {
    process.execPath = savedExecPath;
    if (savedExecpath === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = savedExecpath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── why(): the one detail helper ──

test('why: error message plus stderr tail; stdout tail when stderr is empty; capped at 200', () => {
  const err = new Error('spawnSync npm ENOENT');
  assert.match(why({ status: null, stdout: '', stderr: '', error: err }), /ENOENT/);
  assert.match(why({ status: null, stdout: '', stderr: '  boom\n', error: err }), /ENOENT.*boom/);
  const long = why({ status: 1, stdout: 'HEAD-MARKER\n' + 'a'.repeat(300) + '\nlast line\n', stderr: '' });
  assert.match(long, /last line/);
  assert.ok(!long.includes('HEAD-MARKER'), 'the tail, not the head');
  assert.equal(why({ status: null, stdout: '', stderr: '' }), '');
  assert.match(why({ status: 1, stderr: 'x'.repeat(400) }), /^x{200}$/, 'the tail is capped at 200');
});

// ── DW-1.2: every command step names its spawn failure, detail carries the message ──

/** A tar with one valid file entry — enough for verifyBackup's header checks. */
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
}

// The green-run harness shape (same as selfhost-check.test.mjs, not imported):
// fake git clone writes .env.example from this checkout, psql is a one-row
// database, the backup run writes a verifiable backup. failAt(cmd, args)
// decides which child returns the spawn-failure shape instead of succeeding.
function harness(failAt, failure) {
  const lock = mkdtempSync(path.join(os.tmpdir(), 'vl-lock-'));
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vl-tmp-'));
  const seen = [];
  let rows = 0;
  let backedUpRows = null;

  const exec = (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args[0] === 'clone') {
      const cloneDir = args[args.length - 1];
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(path.join(cloneDir, '.env.example'), readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (failAt(cmd, args)) return failure;
    if (cmd === 'docker' && args.includes('psql')) {
      const sql = args.join(' ');
      if (/insert/i.test(sql)) rows += 1;
      else if (/delete/i.test(sql)) rows = 0;
      else if (/select/i.test(sql)) return { status: 0, stdout: rows + '\n', stderr: '' };
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
    if (cmd === 'npm' && args[0] === 'run') return { status: 0, stdout: '7 passed (2.1s)\n', stderr: '' };
    return { status: 0, stdout: 'abc1234\n', stderr: '' };
  };

  const probe = async () => ({ status: 200, body: { status: 'ok', db: 'connected', build: { version: '1.0.0' } } });
  const cleanup = () => {
    rmSync(lock, { recursive: true, force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  };
  return { lock, tmpRoot, seen, exec, probe, cleanup };
}

const spawnFailure = () => ({ status: null, stdout: '', stderr: '', error: new Error('spawnSync npm ENOENT') });

const SPAWN_FAILURES = [
  { step: 'up', match: (cmd, args) => cmd === 'docker' && args.includes('up') },
  { step: 'backup', match: (cmd, args) => cmd === 'docker' && args.includes('run') && !args.includes('restore.mjs') },
  { step: 'restore', match: (cmd, args) => cmd === 'docker' && args.includes('restore.mjs') },
  { step: 'restore', match: (cmd, args) => cmd === 'docker' && args.includes('psql') && /insert/i.test(args.join(' ')) },
  { step: 'e2e deps', match: (cmd, args) => cmd === 'npm' && args[0] === 'ci' },
  { step: 'e2e browser', match: cmd => cmd === 'npx' },
  { step: 'smoke', match: (cmd, args) => cmd === 'npm' && args[0] === 'run' },
];

for (const { step, match } of SPAWN_FAILURES) {
  test('runCheck: a spawn failure (status null + error) at ' + step + ' is that named failure with ENOENT in the detail (DW-1.2)', async () => {
    const h = harness(match, spawnFailure());
    try {
      const result = await runCheck({
        lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: () => {}, sleep: async () => {}, probe: h.probe,
      });
      assert.equal(result.ok, false);
      assert.equal(result.failed, step);
      const failedStep = result.steps.find(s => s.name === step);
      assert.ok(failedStep && !failedStep.ok);
      assert.match(failedStep.detail, /ENOENT/, 'detail must carry the spawn error: ' + failedStep.detail);
      assert.ok(h.seen.some(l => l.includes('down -v')), 'teardown still runs');
    } finally { h.cleanup(); }
  });
}

test('runCheck: a failing step with empty stderr uses the stdout tail in its detail', async () => {
  const failure = { status: 1, stdout: 'first line\nthe real cause is here\n', stderr: '' };
  const h = harness((cmd, args) => cmd === 'npm' && args[0] === 'ci', failure);
  try {
    const result = await runCheck({
      lock: h.lock, tmpRoot: h.tmpRoot, exec: h.exec, git: h.exec, log: () => {}, sleep: async () => {}, probe: h.probe,
    });
    assert.equal(result.failed, 'e2e deps');
    const detail = result.steps.find(s => s.name === 'e2e deps').detail;
    assert.match(detail, /the real cause is here/);
  } finally { h.cleanup(); }
});
