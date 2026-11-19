// scripts/test/smoke-setup.test.mjs
//
// P5b review fix: e2e/smoke-setup.ts (fetchHealth + smokeSetup) had no test
// referencing it. Mirrors smoke-tls.test.mjs: the TS module is imported in a
// fresh node child per case (BASE_URL is read at module load), against real
// local servers the parent starts on ephemeral ports (port 0 — 8044/8051/8443
// are other stacks'). Covers both fetchHealth branches (plain fetch; the
// E2E_INSECURE_TLS=1 node:https opt-in with NODE_TLS_REJECT_UNAUTHORIZED=0),
// strict TLS refusing the self-signed cert, and smokeSetup's ok / non-2xx /
// unreachable paths. Cert via nginx/make-cert.mjs, nothing committed.
// `node --test`.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const E2E = path.join(ROOT, 'e2e');
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

const HEALTH_BODY = JSON.stringify({ status: 'ok', db: 'connected', build: { version: '9.9.9-test' } });

let cert = null;
function selfSignedCert() {
  if (cert) return cert;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vl-smoke-cert-'));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'nginx', 'make-cert.mjs'), dir], { encoding: 'utf8' });
  assert.equal(res.status, 0, `make-cert failed: ${res.stderr}`);
  cert = { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')), dir };
  return cert;
}
test.after(() => { if (cert) rmSync(cert.dir, { recursive: true, force: true }); });

/** Starts a server on 127.0.0.1 port 0; returns {url, close}. */
function listen(server, scheme) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `${scheme}://127.0.0.1:${server.address().port}`,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

/**
 * Runs smokeSetup in a fresh node child with the given env (undefined = unset);
 * returns {status, stdout, stderr}. Async spawn, not spawnSync: the parent must
 * keep serving its local test server while the child probes it.
 */
function setupWith(envAdd) {
  const code = `
    const setup = (await import(${JSON.stringify('file:///' + path.join(E2E, 'smoke-setup.ts').replace(/\\/g, '/'))})).default;
    try { await setup(); console.log('SETUP_OK'); }
    catch (err) { console.error(err.message); process.exit(1); }
  `;
  const env = { ...process.env, ...envAdd };
  for (const [k, v] of Object.entries(envAdd)) if (v === undefined) delete env[k];
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, cwd: E2E });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const killer = setTimeout(() => child.kill(), 30_000);
    child.on('close', status => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
  });
}

const PLAIN_ENV = { E2E_INSECURE_TLS: undefined, NODE_TLS_REJECT_UNAUTHORIZED: undefined };

test('smokeSetup: plain HTTP health passes and the banner names API build and db', async () => {
  const { url, close } = await listen(createHttpServer((req, res) => {
    assert.equal(req.url, '/api/health');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(HEALTH_BODY);
  }), 'http');
  try {
    const { status, stdout, stderr } = await setupWith({ ...PLAIN_ENV, E2E_BASE_URL: url });
    assert.equal(status, 0, stderr);
    assert.match(stdout, /SETUP_OK/);
    assert.ok(stdout.includes(`smoke → ${url} (API 9.9.9-test, db connected)`), stdout);
  } finally { await close(); }
});

test('smokeSetup: self-signed HTTPS passes with E2E_INSECURE_TLS=1 + NODE_TLS_REJECT_UNAUTHORIZED=0', { skip: !hasOpenssl }, async () => {
  const { key, cert: pem } = selfSignedCert();
  const { url, close } = await listen(createHttpsServer({ key, cert: pem }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(HEALTH_BODY);
  }), 'https');
  try {
    const { status, stdout, stderr } = await setupWith({
      E2E_BASE_URL: url, E2E_INSECURE_TLS: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    });
    assert.equal(status, 0, stderr);
    assert.match(stdout, /SETUP_OK/);
    assert.ok(stdout.includes(`smoke → ${url} (API 9.9.9-test, db connected)`), stdout);
  } finally { await close(); }
});

test('smokeSetup: strict TLS refuses the self-signed cert — named Cannot reach, not a raw stack', { skip: !hasOpenssl }, async () => {
  const { key, cert: pem } = selfSignedCert();
  const { url, close } = await listen(createHttpsServer({ key, cert: pem }, (req, res) => {
    res.writeHead(200); res.end(HEALTH_BODY);
  }), 'https');
  try {
    const { status, stderr } = await setupWith({ ...PLAIN_ENV, E2E_BASE_URL: url });
    assert.equal(status, 1);
    assert.ok(stderr.includes(`Cannot reach ${url}`), stderr);
    assert.match(stderr, /docker compose up -d/, 'the error tells the admin how to start the stack');
    // fetch's contract: the TLS detail lives on err.cause; the message string carries `TypeError: fetch failed`.
    assert.match(stderr, /fetch failed/, `the fetch rejection is carried: ${stderr}`);
  } finally { await close(); }
});

test('smokeSetup: a non-2xx health answer is refused with the status, not treated as up', async () => {
  const { url, close } = await listen(createHttpServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"status":"degraded"}');
  }), 'http');
  try {
    const { status, stderr } = await setupWith({ ...PLAIN_ENV, E2E_BASE_URL: url });
    assert.equal(status, 1);
    assert.ok(stderr.includes(`${url}/api/health returned 503`), stderr);
    assert.match(stderr, /the API or its database is down/);
  } finally { await close(); }
});

test('smokeSetup: an unreachable base URL is the Cannot reach error with the start hint', async () => {
  // Take an ephemeral port, then release it: nothing listens there.
  const { url, close } = await listen(createHttpServer(), 'http');
  await close();
  const { status, stderr } = await setupWith({ ...PLAIN_ENV, E2E_BASE_URL: url });
  assert.equal(status, 1);
  assert.ok(stderr.includes(`Cannot reach ${url}`), stderr);
  assert.match(stderr, /docker compose up -d/);
  assert.match(stderr, /E2E_BASE_URL/);
});
