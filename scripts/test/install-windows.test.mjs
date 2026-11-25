// scripts/test/install-windows.test.mjs
//
// HO1a Phase 1 (DW-1.1 .. DW-1.4): black-box tests of install.cmd /
// install.ps1 through the real wrappers with a fake docker first on PATH
// (scripts/test/install-harness.mjs). No Docker daemon is needed.
// Off Windows, or without stock Windows PowerShell 5.1, each test
// returns early - no skip/todo (milestone gate rule).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT, canRun, makeSandbox, runInstaller, secretValues, withTemplateSecrets } from './install-harness.mjs';

const SECRET_SHAPE = /^[0-9a-f]{64}$/;
const PLACEHOLDER = 'change-me-before-deploying';

// DW-1.1 (AC-7 shape): repo template, daemon up -> exit 0, .env created
// with two fresh 64-hex secrets, every other byte identical, exactly the
// two docker calls in order, health URL on stdout. Both routes.
for (const via of ['cmd', 'powershell']) {
  test(`DW-1.1: install via ${via} creates .env from the template, byte-preserving, two docker calls, health URL`, () => {
    if (!canRun()) return; // not Windows / no PowerShell 5.1
    const template = fs.readFileSync(path.join(ROOT, '.env.example'));
    const sandbox = makeSandbox();
    try {
      const run = runInstaller(sandbox, { via });
      assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
      const envPath = path.join(sandbox.dir, '.env');
      assert.ok(fs.existsSync(envPath), '.env must be created');
      const env = fs.readFileSync(envPath);
      const secrets = secretValues(env);
      for (const key of ['DB_PASSWORD', 'ADMIN_TOKEN']) {
        assert.match(secrets[key], SECRET_SHAPE, `${key} must be 64 lowercase hex chars`);
        assert.notEqual(secrets[key], PLACEHOLDER, `${key} must not stay the placeholder`);
      }
      assert.notEqual(secrets.DB_PASSWORD, secrets.ADMIN_TOKEN, 'the two secrets must differ');
      assert.equal(Buffer.compare(withTemplateSecrets(env, template), template), 0,
        'every byte except the two secret values must equal the template');
      assert.deepEqual(run.dockerCalls, ['info', 'compose up -d --build']);
      assert.ok(run.stdout.includes('http://localhost:8044/api/health'), 'stdout must carry the health URL');
      // No secret may reach any output channel or the fake docker log.
      for (const value of Object.values(secrets)) {
        assert.ok(!run.stdout.includes(value), 'a secret was echoed on stdout');
        assert.ok(!run.stderr.includes(value), 'a secret was echoed on stderr');
        assert.ok(!run.dockerCalls.some((line) => line.includes(value)), 'a secret reached docker argv');
      }
    } finally {
      sandbox.cleanup();
    }
  });
}

// DW-1.2 (AC-8 shape): daemon down (silent / stderr+exit 1) or docker
// absent -> non-zero exit, the clean English message, no PowerShell
// exception text, no .env, no compose call. Both routes for each shape.
for (const via of ['cmd', 'powershell']) {
  for (const shape of [
    { name: 'info exits 1 silently', opts: { infoExit: 1 } },
    { name: 'info exits 1 with stderr text', opts: { infoExit: 1, infoStderr: true } },
    { name: 'docker not on PATH', opts: { path: 'no-docker' } },
  ]) {
    test(`DW-1.2: ${shape.name} (via ${via}) fails cleanly before anything is written`, () => {
      if (!canRun()) return;
      const sandbox = makeSandbox();
      try {
        const run = runInstaller(sandbox, { via, ...shape.opts });
        assert.notEqual(run.status, 0, 'a failed daemon check must exit non-zero');
        const all = run.stdout + run.stderr;
        assert.ok(all.includes('Docker is not running'), `clean message expected, got:\n${all}`);
        assert.ok(!all.includes('RemoteException'), 'no PowerShell exception text');
        assert.ok(!all.includes('NativeCommandError'), 'no PowerShell exception text');
        assert.ok(!fs.existsSync(path.join(sandbox.dir, '.env')), 'no .env may be created');
        assert.ok(!run.dockerCalls.some((line) => line.includes('compose')), 'no compose call after a failed gate');
      } finally {
        sandbox.cleanup();
      }
    });
  }
}

// DW-1.3 (AC-8 existing .env): bytes and mtime untouched, compose still
// runs, the health URL follows the file's own port.
test('DW-1.3: an existing .env stays byte-identical with the same mtime; compose runs; URL uses its port', () => {
  if (!canRun()) return;
  const existing = Buffer.from(
    '# Мій власний файл середовища\r\nDB_HOST=database\r\nDB_PASSWORD=already-set-password-value\r\nADMIN_TOKEN=already-set-admin-token-value\r\nFRONTEND_PORT=8123\r\n',
    'utf8');
  const template = fs.readFileSync(path.join(ROOT, '.env.example'));
  assert.notEqual(Buffer.compare(existing, template), 0, 'fixture must differ from the template');
  const sandbox = makeSandbox({ existingEnv: existing });
  try {
    const envPath = path.join(sandbox.dir, '.env');
    const mtimeBefore = fs.statSync(envPath).mtimeMs;
    const run = runInstaller(sandbox, { via: 'cmd' });
    assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.equal(Buffer.compare(fs.readFileSync(envPath), existing), 0, '.env must stay byte-identical');
    assert.equal(fs.statSync(envPath).mtimeMs, mtimeBefore, '.env mtime must not move');
    assert.deepEqual(run.dockerCalls, ['info', 'compose up -d --build']);
    assert.ok(run.stdout.includes('http://localhost:8123/api/health'), 'URL must follow the existing FRONTEND_PORT');
    assert.ok(run.stdout.includes('left unchanged'), 'the D7 message must be shown');
  } finally {
    sandbox.cleanup();
  }
});

// DW-1.4: started from another cwd, .env lands next to the script, not
// in the cwd; a failed compose keeps the fresh .env (D4.6).
test('DW-1.4: another cwd -> .env next to the script; compose failure -> exit 1, .env kept', () => {
  if (!canRun()) return;
  const sandbox = makeSandbox();
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vl other cwd '));
  try {
    const ok = runInstaller(sandbox, { via: 'cmd', cwd: otherCwd });
    assert.equal(ok.status, 0, `stdout:\n${ok.stdout}\nstderr:\n${ok.stderr}`);
    assert.ok(fs.existsSync(path.join(sandbox.dir, '.env')), '.env must be created next to the script');
    assert.ok(!fs.existsSync(path.join(otherCwd, '.env')), 'no .env may appear in the caller cwd');

    // A fresh sandbox for the compose-failure leg: exit 1, .env kept.
    const failSandbox = makeSandbox();
    try {
      const bad = runInstaller(failSandbox, { via: 'cmd', composeExit: 1, cwd: otherCwd });
      assert.equal(bad.status, 1, 'a failed compose must exit 1');
      assert.ok((bad.stdout + bad.stderr).includes('FAILED:'), 'the house failure prefix must be used');
      assert.ok(fs.existsSync(path.join(failSandbox.dir, '.env')), 'the fresh .env must be kept after a compose failure');
      assert.deepEqual(bad.dockerCalls, ['info', 'compose up -d --build']);
    } finally {
      failSandbox.cleanup();
    }
  } finally {
    sandbox.cleanup();
    fs.rmSync(otherCwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
