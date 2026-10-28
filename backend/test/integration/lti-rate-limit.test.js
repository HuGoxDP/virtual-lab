// H.2: the LTI rate limit buckets by the client address Express derives, so what it believes of
// X-Forwarded-For (the `trust proxy` setting) is what a client can or cannot spoof. No database needed:
// /jwks does not touch it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');

const { createLtiRouter } = require('../../lti');
const { parseTrustProxy } = require('../../trust-proxy');

const TOOL_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });
const LIMIT = 3;

function buildApp(trustProxy) {
  const app = express();
  if (trustProxy !== undefined) app.set('trust proxy', parseTrustProxy(trustProxy).value);
  app.use('/api/lti', createLtiRouter({
    pool: { query: async () => ({ rows: [] }) },
    env: { LTI_PUBLIC_URL: 'https://tool.test', LTI_TOOL_PRIVATE_KEY: TOOL_KEY, LTI_RATE_LIMIT: String(LIMIT) },
  }));
  return app;
}

const hit = (app, forwardedFor) => {
  const req = request(app).get('/api/lti/jwks');
  return forwardedFor ? req.set('X-Forwarded-For', forwardedFor) : req;
};

async function exhaust(app, forwardedFor) {
  for (let i = 0; i < LIMIT; i++) assert.equal((await hit(app, forwardedFor)).status, 200);
  assert.equal((await hit(app, forwardedFor)).status, 429);
}

test('H_2 behind one trusted proxy two forwarded clients get separate buckets', async () => {
  const app = buildApp('1');

  await exhaust(app, '203.0.113.1');

  assert.equal((await hit(app, '203.0.113.2')).status, 200, 'another client is unaffected');
  assert.equal((await hit(app, '203.0.113.1')).status, 429, 'the first stays limited');
});

test('H_2 with two proxies in a row (TLS proxy + nginx) the client is the entry before both', async () => {
  const app = buildApp('2');

  // Real chain: "<client>, <first proxy>"; the socket peer is the second proxy.
  await exhaust(app, '203.0.113.1, 172.18.0.5');

  assert.equal((await hit(app, '203.0.113.2, 172.18.0.5')).status, 200);
  // A client that prepends its own entries does not move the one our proxies appended.
  assert.equal((await hit(app, 'spoofed-1, 203.0.113.1, 172.18.0.5')).status, 429);
  assert.equal((await hit(app, 'spoofed-2, 203.0.113.1, 172.18.0.5')).status, 429);
});

test('H_2 without trust a spoofed X-Forwarded-For cannot buy a fresh bucket', async () => {
  for (const setting of [undefined, '0']) {
    const app = buildApp(setting);
    for (let i = 0; i < LIMIT; i++) assert.equal((await hit(app, `198.51.100.${i}`)).status, 200);

    assert.equal((await hit(app, '198.51.100.99')).status, 429, `TRUST_PROXY=${setting}: header ignored`);
    assert.equal((await hit(app)).status, 429, `TRUST_PROXY=${setting}: same bucket without the header`);
  }
});
