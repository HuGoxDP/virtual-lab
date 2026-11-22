// scripts/test/https-redirect.test.mjs
//
// P5b D2: the entrypoint-rendered redirect include. nginx/10-https-redirect.sh
// validates HTTPS_REDIRECT_PORT and renders the include nginx.conf loads in
// the server block: unset = empty file (the plain stack is untouched), a valid
// port = `if ($vl_forwarded_proto = http)` with a `return 301` (the only safe if-in-server
// form), anything else = exit 1 and no include, so an operator typo cannot
// start a broken or widened config. Mirrors backend/test/unit/nginx-lti-frame.
// `node --test`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NGINX = path.join(ROOT, 'nginx');
const SCRIPT = path.join(NGINX, '10-https-redirect.sh');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

/** Runs the script with the given HTTPS_REDIRECT_PORT (undefined = unset); returns exit code and rendered include. */
function render(value) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'https-redirect-'));
  const out = path.join(dir, 'https-redirect.conf');
  const env = { PATH: process.env.PATH, HTTPS_REDIRECT_CONF: out };
  if (value !== undefined) env.HTTPS_REDIRECT_PORT = value;
  const res = spawnSync('sh', [SCRIPT], { env, encoding: 'utf8' });
  const conf = existsSync(out) ? readFileSync(out, 'utf8') : null;
  rmSync(dir, { recursive: true, force: true });
  return { status: res.status, stderr: res.stderr, conf };
}

test('redirect include: unset or blank renders an empty file — the plain stack is unaffected', { skip: !hasSh }, () => {
  for (const value of [undefined, '', '   ']) {
    const { status, conf } = render(value);
    assert.equal(status, 0, `unset/blank must not fail the start: ${value}`);
    assert.equal(conf.trim(), '', 'an empty include is a no-op in nginx');
  }
});

test('redirect include: a numeric port renders the safe if-with-return 301 to the https listener', { skip: !hasSh }, () => {
  const { status, conf } = render('8462');
  assert.equal(status, 0);
  assert.ok(conf, 'a valid port produces an include');
  assert.match(conf, /if \(\$vl_forwarded_proto = http\)/,
    'P5d: the condition reads the forwarded-proto map, so a TLS proxy that terminates TLS is honoured');
  assert.ok(!/\$scheme/.test(conf),
    'P5d: `$scheme` would redirect a proxied request to itself forever — the rendered include must not test it');
  assert.match(conf, /return\s+301\s+https:\/\/\$host:8462\$request_uri;/,
    'path+query preserved, host from the request, pinned port — and `return` is the only safe if-in-server body');
});

// P5d: the redirect condition is only correct together with the map it reads. Model the map
// (`map $http_x_forwarded_proto $vl_forwarded_proto { default $scheme; https https; }`) and the
// rendered include, then check the four cases a real nginx would answer. A live request leg needs
// Docker/nginx; this test pins the semantics the config states, and the https selfhost-check leg
// (P5b) exercises a real container.
test('redirect decision: X-Forwarded-Proto https is served, absent/plain http redirects', { skip: !hasSh }, () => {
  const nginx = readFileSync(path.join(NGINX, 'nginx.conf'), 'utf8');
  const map = nginx.match(/map\s+\$http_x_forwarded_proto\s+\$vl_forwarded_proto\s*\{([^}]*)\}/);
  assert.ok(map, 'nginx.conf must build $vl_forwarded_proto from $http_x_forwarded_proto');
  assert.match(map[1], /default\s+\$scheme/, 'no header = the connection\'s own scheme');

  const { conf } = render('8443');
  assert.ok(conf && /if \(\$vl_forwarded_proto = http\)/.test(conf), 'the include must test the map');

  /** The map's answer for one request (what nginx resolves `$vl_forwarded_proto` to). */
  const forwarded = (header, scheme) => {
    const value = header === undefined ? scheme : (header === 'https' ? 'https' : scheme);
    return /default\s+\$scheme/.test(map[1]) && header !== 'https' ? scheme : value;
  };
  const redirects = (header, scheme) => forwarded(header, scheme) === 'http';

  assert.equal(redirects('https', 'http'), false,
    'a TLS proxy forwarding plain http with X-Forwarded-Proto: https must be SERVED (200), not looped');
  assert.equal(redirects(undefined, 'http'), true, 'a direct plain request still gets 301');
  assert.equal(redirects('http', 'http'), true, 'an explicit http upstream still gets 301');
  assert.equal(redirects('https', 'https'), false, 'a request already on TLS is served');
});

test('redirect include: a non-numeric or out-of-range port exits 1 and writes no include', { skip: !hasSh }, () => {
  const bad = ['abc', '8462x', '8443;', '8443 }', 'http://x', '-1', '0', '99999', '*', '8443; return 200'];
  for (const value of bad) {
    const { status, conf, stderr } = render(value);
    assert.equal(status, 1, `${JSON.stringify(value)} must be refused`);
    assert.equal(conf, null, `${JSON.stringify(value)} must not produce a config`);
    assert.match(stderr, /HTTPS_REDIRECT_PORT/, 'the failure names the variable');
  }
});

test('redirect wiring: nginx.conf includes the rendered file, the image runs the script, https.yml interpolates the port', () => {
  const nginx = readFileSync(path.join(NGINX, 'nginx.conf'), 'utf8');
  assert.match(nginx, /include \/etc\/nginx\/https-redirect\.conf;/, 'the server block loads the rendered include');

  const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile.frontend'), 'utf8');
  assert.match(dockerfile, /10-https-redirect\.sh/, 'the image copies the renderer into /docker-entrypoint.d/');

  const httpsYml = readFileSync(path.join(ROOT, 'docker-compose.https.yml'), 'utf8');
  assert.match(httpsYml, /HTTPS_REDIRECT_PORT/, 'the https overlay passes the redirect port to nginx');
});
