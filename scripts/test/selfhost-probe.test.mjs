// scripts/test/selfhost-probe.test.mjs
//
// P5b review fix: httpProbe (scripts/selfhost-check.mjs) is the driver's real
// network probe — runCheck's tests inject a fake, so this file exercises the
// function itself against real local servers on ephemeral ports (port 0, no
// fixed-port collisions with the lab stack): the 301 contract (headers back,
// redirect NOT followed), the self-signed opt-in, the non-JSON body contract
// (body: undefined, no throw) and the timeout path. The certificate comes from
// nginx/make-cert.mjs, the same generator the stack's image uses — nothing
// self-signed is committed. `node --test`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { httpProbe } from '../selfhost-check.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

/** One self-signed cert for the whole file, via the image's own generator. */
let cert = null;
function selfSignedCert() {
  if (cert) return cert;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vl-probe-cert-'));
  const res = spawnSync(process.execPath, [path.join(ROOT, 'nginx', 'make-cert.mjs'), dir], { encoding: 'utf8' });
  assert.equal(res.status, 0, `make-cert failed: ${res.stderr}`);
  cert = { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')), dir };
  return cert;
}
test.after(() => { if (cert) rmSync(cert.dir, { recursive: true, force: true }); });

/** Starts a server on 127.0.0.1 port 0 and returns {server, url, close}. */
function listen(server, scheme = 'http') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server, url: `${scheme}://127.0.0.1:${server.address().port}`,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

test('httpProbe: a 301 comes back with its headers and the redirect is NOT followed', async () => {
  let redirectedHits = 0;
  const { server, url, close } = await listen(createHttpServer((req, res) => {
    if (req.url === '/redirected') { redirectedHits += 1; res.writeHead(200); res.end('{}'); return; }
    res.writeHead(301, { Location: `${url}/redirected`, 'X-Probe-Test': 'yes' });
    res.end();
  }));
  try {
    const answer = await httpProbe(`${url}/plain?x=1`);
    assert.equal(answer.status, 301);
    assert.equal(answer.headers.location, `${url}/redirected`);
    assert.equal(answer.headers['x-probe-test'], 'yes');
    assert.equal(redirectedHits, 0, 'the probe must stop at the redirect — the https step judges it');
  } finally { await close(); }
});

test('httpProbe: a JSON body is parsed; a non-JSON body is undefined, never a throw', async () => {
  const { server, url, close } = await listen(createHttpServer((req, res) => {
    if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>not json</html>');
  }));
  try {
    const json = await httpProbe(`${url}/json`);
    assert.equal(json.status, 200);
    assert.deepEqual(json.body, { status: 'ok' });
    const html = await httpProbe(`${url}/html`);
    assert.equal(html.status, 200);
    assert.equal(html.body, undefined, 'unparseable text resolves with body:undefined — judgeHealth names it');
  } finally { await close(); }
});

test('httpProbe: https with the stack\'s self-signed cert is accepted (rejectUnauthorized:false)', { skip: !hasOpenssl }, async () => {
  const { key, cert: pem } = selfSignedCert();
  const { server, url, close } = await listen(createHttpsServer({ key, cert: pem }, (req, res) => {
    res.writeHead(200, { 'Strict-Transport-Security': 'max-age=31536000' });
    res.end('{"status":"ok"}');
  }), 'https');
  try {
    const answer = await httpProbe(`${url}/api/health`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { status: 'ok' });
    assert.equal(answer.headers['strict-transport-security'], 'max-age=31536000');
  } finally { await close(); }
});

test('httpProbe: a silent server hits the timeout and rejects with the named error', async () => {
  const { server, url, close } = await listen(createHttpServer(() => { /* accept, never answer */ }));
  try {
    await assert.rejects(httpProbe(`${url}/slow`, 150), /probe timed out after 150ms/);
  } finally { await close(); }
});
