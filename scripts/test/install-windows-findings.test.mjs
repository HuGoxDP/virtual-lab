// scripts/test/install-windows-findings.test.mjs
//
// HO1a premerge findings, round 1 (review fixes): regression pins for
// F1 (frozen-fixture doc guard, no live git ref), F2 (ACL warning in the
// Windows subsection), F3 (env-override NOTEs for the secret keys, key
// name only), F4 (the harness SystemRoot fallback is a real path).
// Pattern: install-windows.test.mjs - harness sandbox runs on Windows,
// static fs checks on every platform; early return off Windows, never
// skip/todo.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, canRun, makeSandbox, runInstaller, secretValues } from './install-harness.mjs';

const NEW_HEADING = '### Windows: встановлення однією командою (install.cmd)';
const DOC_PATH = path.join(ROOT, 'docs', 'self-host.md');
const FIXTURE_PATH = path.join(ROOT, 'scripts', 'test', 'fixtures', 'self-host-pre-ho1a.md');
const GUARD_PATH = path.join(ROOT, 'scripts', 'test', 'install-windows-doc.test.mjs');
const DOC = fs.readFileSync(DOC_PATH, 'utf8').replace(/\r\n/g, '\n');

/** The Windows subsection: heading through the line before the next ###. */
function windowsSubsection(doc) {
  const start = doc.indexOf(NEW_HEADING);
  assert.notEqual(start, -1, 'the Windows heading must exist');
  const end = doc.indexOf('### Перший модератор', start);
  assert.ok(end > start, '### Перший модератор must follow the subsection');
  return doc.slice(start, end);
}

/** A temp copy of the doc-guard layout: docs/ + scripts/test/{,fixtures}. */
function makeGuardSandbox(docText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ho1a guard sim '));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.mkdirSync(path.join(dir, 'scripts', 'test', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'self-host.md'), docText);
  fs.copyFileSync(GUARD_PATH, path.join(dir, 'scripts', 'test', 'install-windows-doc.test.mjs'));
  fs.copyFileSync(FIXTURE_PATH, path.join(dir, 'scripts', 'test', 'fixtures', 'self-host-pre-ho1a.md'));
  return {
    dir,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); },
  };
}

// The child must run its own test runner: an inherited NODE_TEST_CONTEXT
// (set by the outer node --test) turns a nested `node --test` into a
// recursive no-op that exits 0 without running anything.
function runGuard(dir) {
  const r = spawnSync(process.execPath, ['--test', 'scripts/test/install-windows-doc.test.mjs'], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.ok(!r.error, String(r.error));
  return r;
}

// ---- F1: the frozen fixture ----

test('F1: the pre-HO1a fixture exists and predates the Windows subsection', () => {
  const fixture = fs.readFileSync(FIXTURE_PATH, 'utf8');
  assert.ok(!fixture.includes(NEW_HEADING), 'the fixture must NOT contain the new heading');
  assert.ok(!fixture.includes('install.cmd'), 'the fixture must NOT mention install.cmd');
});

test('F1: the doc guard passes when origin/ms/1 already carries the post-HO1a doc (post-merge simulation)', () => {
  // The exact scenario that broke the old live-ref guard: a repo whose
  // origin/ms/1 ref points at a commit containing the CURRENT doc. The
  // fixture-based guard must stay green there (it never consults git).
  const sim = makeGuardSandbox(fs.readFileSync(DOC_PATH));
  try {
    const g = (args) => spawnSync('git', ['-c', 'user.email=sim@local', '-c', 'user.name=sim', ...args],
      { cwd: sim.dir, encoding: 'utf8', timeout: 30000 });
    let r = g(['init', '-q']);
    assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
    r = g(['add', '.']);
    assert.equal(r.status, 0, `git add failed: ${r.stderr}`);
    r = g(['commit', '-q', '-m', 'post-ho1a snapshot']);
    assert.equal(r.status, 0, `git commit failed: ${r.stderr}`);
    const head = g(['rev-parse', 'HEAD']).stdout.trim();
    fs.mkdirSync(path.join(sim.dir, '.git', 'refs', 'remotes', 'origin', 'ms'), { recursive: true });
    fs.writeFileSync(path.join(sim.dir, '.git', 'refs', 'remotes', 'origin', 'ms', '1'), head + '\n');
    const run = runGuard(sim.dir);
    assert.equal(run.status, 0, `guard must pass post-merge:\n${run.stdout}\n${run.stderr}`);
  } finally {
    sim.cleanup();
  }
});

test('F1: a reworded line outside «Встановлення» still fails the fixture guard (the guard still guards)', () => {
  const anchor = 'Цей документ — для адміністратора університету';
  assert.ok(DOC.includes(anchor), 'the reword anchor must exist outside the install section');
  const reworded = DOC.replace(anchor, 'Цей документ — для адміністратора ліцею');
  const sim = makeGuardSandbox(reworded);
  try {
    const run = runGuard(sim.dir);
    assert.notEqual(run.status, 0, `a reworded line outside the section must fail the guard
${run.stdout}
${run.stderr}`);
    assert.ok(/must be unchanged/.test(run.stdout + run.stderr),
      'the failure must be the additions-only assertion');
  } finally {
    sim.cleanup();
  }
});

// ---- F2: the ACL warning ----

test('F2: the Windows subsection warns about inherited ACLs on .env (static)', () => {
  const sub = windowsSubsection(DOC);
  assert.match(sub, /ACL/, 'the ACL inheritance must be named');
  assert.match(sub, /Users/, 'the readable-by-others example (BUILTIN\\Users) must be named');
  assert.ok(/icacls|Безпека/.test(sub), 'a way to restrict access must be named (icacls or file Security tab)');
});

// ---- F3: env-override NOTEs for the secret keys ----

test('F3: env DB_PASSWORD/ADMIN_TOKEN set -> a NOTE per key, no value echo, .env created normally', () => {
  if (!canRun()) return;
  const dummyDb = 'dummy-db-override-value';
  const dummyAdmin = 'dummy-admin-override-value';
  const sandbox = makeSandbox();
  try {
    const run = runInstaller(sandbox, {
      env: { DB_PASSWORD: dummyDb, ADMIN_TOKEN: dummyAdmin, FRONTEND_PORT: '' },
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /NOTE: DB_PASSWORD is set in the environment; compose uses it instead of the \.env value\./);
    assert.match(run.stdout, /NOTE: ADMIN_TOKEN is set in the environment; compose uses it instead of the \.env value\./);
    for (const value of [dummyDb, dummyAdmin]) {
      assert.ok(!run.stdout.includes(value), 'an env secret value was echoed on stdout');
      assert.ok(!run.stderr.includes(value), 'an env secret value was echoed on stderr');
      assert.ok(!run.dockerCalls.some((l) => l.includes(value)), 'an env secret value reached docker argv');
    }
    assert.deepEqual(run.dockerCalls, ['info', 'compose up -d --build']);
    const secrets = secretValues(fs.readFileSync(path.join(sandbox.dir, '.env')));
    for (const value of Object.values(secrets)) {
      assert.match(value, /^[0-9a-f]{64}$/, 'a created secret must be 64 lowercase hex');
      assert.ok(!run.stdout.includes(value) && !run.stderr.includes(value), 'a created secret was echoed');
    }
    assert.notEqual(secrets.DB_PASSWORD, secrets.ADMIN_TOKEN, 'the two secrets must differ');
  } finally {
    sandbox.cleanup();
  }
});

test('F3: env DB_PASSWORD/ADMIN_TOKEN cleared -> no NOTE at all', () => {
  if (!canRun()) return;
  const sandbox = makeSandbox();
  try {
    const run = runInstaller(sandbox, { env: { DB_PASSWORD: '', ADMIN_TOKEN: '', FRONTEND_PORT: '' } });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(!run.stdout.includes('NOTE:'), `no NOTE may fire with the keys unset:\n${run.stdout}`);
  } finally {
    sandbox.cleanup();
  }
});

test('F3: an existing .env stays byte-identical with the same mtime while the env NOTEs still show', () => {
  if (!canRun()) return;
  const existing = Buffer.from(
    'DB_PASSWORD=already-set-password-value\r\nADMIN_TOKEN=already-set-admin-token-value\r\nFRONTEND_PORT=8123\r\n',
    'utf8');
  const sandbox = makeSandbox({ existingEnv: existing });
  try {
    const envPath = path.join(sandbox.dir, '.env');
    const mtimeBefore = fs.statSync(envPath).mtimeMs;
    const run = runInstaller(sandbox, {
      env: { DB_PASSWORD: 'dummy-db-override-value', ADMIN_TOKEN: 'dummy-admin-override-value', FRONTEND_PORT: '' },
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(Buffer.compare(fs.readFileSync(envPath), existing), 0, '.env must stay byte-identical');
    assert.equal(fs.statSync(envPath).mtimeMs, mtimeBefore, '.env mtime must not move');
    assert.match(run.stdout, /NOTE: DB_PASSWORD is set in the environment/);
    assert.match(run.stdout, /NOTE: ADMIN_TOKEN is set in the environment/);
    assert.ok(!run.stdout.includes('dummy-db-override-value') && !run.stdout.includes('dummy-admin-override-value'),
      'no env value echo');
  } finally {
    sandbox.cleanup();
  }
});

// ---- F4: the harness SystemRoot fallback ----

test('F4: the harness fallback is the escaped literal (static, every platform)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'test', 'install-harness.mjs'), 'utf8');
  assert.ok(src.includes(String.raw`'C:\\Windows'`),
    'the fallback must be the two-backslash JS literal');
  assert.ok(!src.includes(String.raw`'C:\Windows'`),
    'the one-backslash literal decays to C:Windows (a drive-relative path) and must be gone');
});