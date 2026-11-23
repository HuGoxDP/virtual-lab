// scripts/test/install-harness.mjs
//
// HO1a Phase 1: shared harness for the Windows installer tests. Not a test
// file itself (the *.test.mjs glob does not run it). Every installer run
// happens in a throwaway sandbox whose name contains a space, against a
// fake docker.cmd first on PATH - no Docker daemon is ever needed, and no
// mode lets a real machine docker win (research D11).
//
// Node cannot spawn a .cmd directly (EINVAL, the CVE-2024-27980 fix):
// every spawn goes through cmd.exe or powershell.exe explicitly.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\Windows', 'System32');
export const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** win32 with stock Windows PowerShell 5.1 present. */
export function canRun() {
  return process.platform === 'win32' && fs.existsSync(POWERSHELL);
}

/**
 * A temp sandbox: install.ps1 + install.cmd copied from the repo,
 * .env.example = template (default: the repo file's bytes), and .env
 * written only when existingEnv is given. The dir name contains a space
 * so every spawn exercises the quoting of a path with spaces.
 */
export function makeSandbox({ template, existingEnv } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl install test '));
  assert.ok(dir.includes(' '), 'the sandbox path must contain a space');
  fs.copyFileSync(path.join(ROOT, 'install.ps1'), path.join(dir, 'install.ps1'));
  fs.copyFileSync(path.join(ROOT, 'install.cmd'), path.join(dir, 'install.cmd'));
  fs.writeFileSync(path.join(dir, '.env.example'), template ?? fs.readFileSync(path.join(ROOT, '.env.example')));
  if (existingEnv !== undefined) fs.writeFileSync(path.join(dir, '.env'), existingEnv);
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    },
  };
}

// The fake docker (research D11): appends %* to FAKE_DOCKER_LOG, exits
// FAKE_DOCKER_INFO_EXIT for `info` and FAKE_DOCKER_COMPOSE_EXIT (default
// 0) for anything else. FAKE_DOCKER_INFO_STDERR=1 adds a stderr line to
// `info` (the real `docker info` writes to stderr exactly when the daemon
// is down). CRLF on purpose: cmd.exe parse bugs with LF-only batch files.
const FAKE_DOCKER = [
  '@echo off',
  'if not "%FAKE_DOCKER_LOG%"=="" >>"%FAKE_DOCKER_LOG%" echo %*',
  'if "%~1"=="info" (',
  '  if "%FAKE_DOCKER_INFO_STDERR%"=="1" echo error during connect: daemon not reachable 1>&2',
  '  if "%FAKE_DOCKER_INFO_EXIT%"=="" (exit /b 0) else (exit /b %FAKE_DOCKER_INFO_EXIT%)',
  ')',
  'if "%FAKE_DOCKER_COMPOSE_EXIT%"=="" (exit /b 0) else (exit /b %FAKE_DOCKER_COMPOSE_EXIT%)',
  '',
].join('\r\n');

/**
 * Run the installer in the sandbox. Returns {status, stdout, stderr,
 * dockerCalls}: one line of argv per fake docker call.
 *
 * PATH modes: 'fake-first' = fake dir + inherited PATH (the fake still
 * wins); 'fake-only' = fake dir + System32 only; 'no-docker' = System32
 * only. via:'cmd' uses the verbatim /d /s /c ""<path>"" pattern that
 * handles the space in the sandbox path from any cwd.
 */
export function runInstaller(sandbox, {
  via = 'cmd',
  infoExit = 0,
  infoStderr = false,
  composeExit = 0,
  path: pathMode = 'fake-first',
  env = {},
  cwd,
} = {}) {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl fake docker '));
  const logFile = path.join(fakeDir, 'calls.log');
  fs.writeFileSync(path.join(fakeDir, 'docker.cmd'), FAKE_DOCKER);
  const inheritedPath = process.env.PATH || process.env.Path || '';
  const childPath = pathMode === 'fake-first' ? `${fakeDir};${inheritedPath}`
    : pathMode === 'fake-only' ? `${fakeDir};${SYSTEM32}`
      : SYSTEM32; // 'no-docker'
  const childEnv = {
    ...process.env,
    PATH: childPath,
    Path: childPath,
    FAKE_DOCKER_LOG: logFile,
    FAKE_DOCKER_INFO_EXIT: String(infoExit),
    FAKE_DOCKER_INFO_STDERR: infoStderr ? '1' : '0',
    FAKE_DOCKER_COMPOSE_EXIT: String(composeExit),
    ...env,
  };
  let exe;
  let args;
  let windowsVerbatimArguments = false;
  if (via === 'cmd') {
    exe = path.join(SYSTEM32, 'cmd.exe');
    args = ['/d', '/s', '/c', `""${path.join(sandbox.dir, 'install.cmd')}""`];
    windowsVerbatimArguments = true;
  } else {
    exe = POWERSHELL;
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(sandbox.dir, 'install.ps1')];
  }
  const result = spawnSync(exe, args, {
    cwd: cwd ?? sandbox.dir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000, // a prompt would hit EOF or hang; a timeout fails the test
    encoding: 'utf8',
    windowsVerbatimArguments,
  });
  const dockerCalls = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : [];
  fs.rmSync(fakeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', dockerCalls };
}

/** The raw values of the two secret key lines (column 0, last wins). */
export function secretValues(envBuf) {
  const text = envBuf.toString('utf8');
  const values = {};
  for (const key of ['DB_PASSWORD', 'ADMIN_TOKEN']) {
    const found = [...text.matchAll(new RegExp(`^${key}=[^\r\n]*`, 'gm'))];
    assert.equal(found.length, 1, `exactly one ${key}= key line expected`);
    values[key] = found[0][0].slice(key.length + 1);
  }
  return values;
}

/**
 * Put the template's two secret values back into a created .env, so the
 * result can be compared byte for byte with the template. Splices bytes
 * (never re-encodes the whole file), so BOM, line endings and a missing
 * final newline survive the round trip.
 */
export function withTemplateSecrets(envBuf, templateBuf) {
  let out = envBuf;
  for (const key of ['DB_PASSWORD', 'ADMIN_TOKEN']) {
    const re = new RegExp(`^${key}=[^\r\n]*`, 'gm');
    const envMatches = [...out.toString('utf8').matchAll(re)];
    const tplMatches = [...templateBuf.toString('utf8').matchAll(re)];
    assert.equal(envMatches.length, 1, `exactly one ${key}= key line in .env`);
    assert.equal(tplMatches.length, 1, `exactly one ${key}= key line in template`);
    const envLine = envMatches[0];
    const tplLine = tplMatches[0][0];
    // Everything in these templates before/inside the key line is ASCII
    // or multi-byte UTF-8; compute the byte offset by encoding the prefix.
    const startByte = Buffer.byteLength(out.toString('utf8').slice(0, envLine.index), 'utf8');
    const endByte = startByte + Buffer.byteLength(envLine[0], 'utf8');
    out = Buffer.concat([out.subarray(0, startByte), Buffer.from(tplLine, 'utf8'), out.subarray(endByte)]);
  }
  return out;
}
