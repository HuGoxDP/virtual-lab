// scripts/test/selfhost-https-judge.test.mjs
//
// P5b D5: the pure judge of the `https` step. Two probe answers go in — the
// plain listener's redirect and the TLS listener's health — and the judge
// names the half that is wrong: http must answer 301 with a Location that
// preserves path+query on the https base, https must answer 200 with HSTS,
// and the plain answer must NOT carry HSTS (it is a TLS-only promise).
// `node --test`.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judgeHttps } from '../selfhost-check.mjs';

const HTTP_BASE = 'http://127.0.0.1:8051';
const HTTPS_BASE = 'https://127.0.0.1:8462';
const HSTS = 'max-age=31536000; includeSubDomains';

/** The two probe answers a correct stack gives for a request to `/`. */
function goodProbes(pathAndQuery = '/') {
  return {
    http: { url: `${HTTP_BASE}${pathAndQuery}`, status: 301, headers: { location: `${HTTPS_BASE}${pathAndQuery}` } },
    https: { status: 200, headers: { 'strict-transport-security': HSTS } },
  };
}

const judge = probes => judgeHttps(probes, { httpsBaseUrl: HTTPS_BASE });

test('judgeHttps: 301 to the right Location plus HSTS on https is green', () => {
  const result = judge(goodProbes());
  assert.equal(result.ok, true, result.reason);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('judgeHttps: the redirect preserves path and query', () => {
  assert.equal(judge(goodProbes('/api/health?x=1')).ok, true);
  // A Location that drops the path is a wrong redirect, not a redirect.
  const wrong = goodProbes('/scenario/abc?draft=1');
  wrong.http.headers.location = `${HTTPS_BASE}/`;
  assert.equal(judge(wrong).ok, false);
});

test('judgeHttps: a plain 200 (no redirect) fails, named', () => {
  const probes = goodProbes();
  probes.http = { url: `${HTTP_BASE}/`, status: 200, headers: {} };
  const result = judge(probes);
  assert.equal(result.ok, false);
  assert.match(result.reason, /301|redirect/i);
});

test('judgeHttps: a 302 is not the pinned redirect', () => {
  const probes = goodProbes();
  probes.http.status = 302;
  assert.equal(judge(probes).ok, false);
});

test('judgeHttps: a 301 to the wrong port or host fails, named', () => {
  for (const location of ['https://127.0.0.1:9999/', 'https://evil.example/', 'http://127.0.0.1:8462/']) {
    const probes = goodProbes();
    probes.http.headers.location = location;
    const result = judge(probes);
    assert.equal(result.ok, false, `Location ${location} must fail`);
    assert.match(result.reason, /location/i);
  }
});

test('judgeHttps: a 301 with no Location header fails, not crashes', () => {
  const probes = goodProbes();
  delete probes.http.headers.location;
  const result = judge(probes);
  assert.equal(result.ok, false);
  assert.match(result.reason, /location/i);
});

test('judgeHttps: https without HSTS fails, named', () => {
  const probes = goodProbes();
  probes.https.headers = {};
  const result = judge(probes);
  assert.equal(result.ok, false);
  assert.match(result.reason, /hsts|strict-transport/i);
});

test('judgeHttps: an empty HSTS value is not HSTS', () => {
  const probes = goodProbes();
  probes.https.headers['strict-transport-security'] = '';
  assert.equal(judge(probes).ok, false);
});

test('judgeHttps: HSTS on the plain answer fails — it is a TLS-only promise', () => {
  const probes = goodProbes();
  probes.http.headers['strict-transport-security'] = HSTS;
  const result = judge(probes);
  assert.equal(result.ok, false);
  assert.match(result.reason, /hsts|strict-transport/i);
});

test('judgeHttps: a non-200 https answer fails, named', () => {
  const probes = goodProbes();
  probes.https.status = 503;
  const result = judge(probes);
  assert.equal(result.ok, false);
  assert.match(result.reason, /503|https/i);
});

test('judgeHttps: header names are matched case-insensitively', () => {
  const probes = goodProbes();
  probes.https.headers = { 'Strict-Transport-Security': HSTS };
  probes.http.headers = { Location: `${HTTPS_BASE}/` };
  assert.equal(judge(probes).ok, true, 'mixed-case header names must still be read');
});

test('judgeHttps: missing probes are a named failure, not a crash', () => {
  assert.equal(judge({}).ok, false);
  assert.equal(judge({ http: { url: `${HTTP_BASE}/`, status: 301, headers: { location: `${HTTPS_BASE}/` } } }).ok, false);
  assert.equal(judgeHttps(undefined, { httpsBaseUrl: HTTPS_BASE }).ok, false);
});
