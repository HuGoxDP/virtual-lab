// scripts/test/smoke-tls.test.mjs
//
// P5b D8: the smoke runs over TLS when the stack requires it. The self-signed
// cert of the throwaway selfcheck stack is not in any trust store, so the
// smoke config opts into `ignoreHTTPSErrors` — but only when the child env
// says E2E_INSECURE_TLS=1 (the check sets it in https mode; a plain run and a
// developer's own stack keep full verification). The config is imported in a
// child process so each case gets a fresh module with its own env.
// `node --test`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const E2E = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'e2e');

/** Imports the smoke config in a fresh node child with the given env additions; returns {status, use, stderr}. */
function configWith(envAdd) {
  const code = `
    const cfg = (await import(${JSON.stringify('file:///' + path.join(E2E, 'playwright.smoke.config.ts').replace(/\\/g, '/'))})).default;
    console.log(JSON.stringify(cfg.use));
  `;
  const env = { ...process.env, ...envAdd };
  for (const [k, v] of Object.entries(envAdd)) if (v === undefined) delete env[k];
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env, encoding: 'utf8', cwd: E2E,
  });
  let use = null;
  try { use = JSON.parse(res.stdout.trim().split('\n').pop()); } catch { /* reported via status/stderr */ }
  return { status: res.status, use, stderr: res.stderr };
}

test('smoke config: E2E_INSECURE_TLS=1 turns on ignoreHTTPSErrors for the self-signed stack', () => {
  const { status, use, stderr } = configWith({ E2E_INSECURE_TLS: '1', E2E_BASE_URL: 'https://127.0.0.1:8462' });
  assert.equal(status, 0, stderr);
  assert.equal(use.ignoreHTTPSErrors, true);
  assert.equal(use.baseURL, 'https://127.0.0.1:8462', 'the https base URL reaches the browser context');
});

test('smoke config: without E2E_INSECURE_TLS verification stays on', () => {
  const { status, use, stderr } = configWith({ E2E_INSECURE_TLS: undefined, E2E_BASE_URL: 'http://127.0.0.1:8051' });
  assert.equal(status, 0, stderr);
  assert.ok(!use.ignoreHTTPSErrors, 'a plain run must not disable TLS verification');
});

test('smoke config: E2E_INSECURE_TLS=0 is not the opt-in', () => {
  const { status, use, stderr } = configWith({ E2E_INSECURE_TLS: '0' });
  assert.equal(status, 0, stderr);
  assert.ok(!use.ignoreHTTPSErrors);
});
