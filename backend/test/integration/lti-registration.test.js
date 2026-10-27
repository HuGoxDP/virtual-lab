// backend/test/integration/lti-registration.test.js
//
// Phase 4 (LTI): Dynamic Registration against a fake platform. Covers DW-4.2 (stored registration, secret
// guard, https-only and same-host configuration) and the error-body half of DW-4.5.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');

const { pool } = require('../../server');
const { createLtiRouter, getRegistration } = require('../../lti');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const {
  PLATFORM, TOOL, CLIENT_ID, DEPLOYMENT_ID, REGISTRATION_TOKEN, REGISTRATION, NS_TOOL,
  createFakePlatform,
} = require('../helpers/fake-platform');

const UKRAINIAN = /[А-Яа-яІіЇїЄєҐґ]/;
const SECRET = 'registration-secret-xyz';
const CONFIG_URL = `${PLATFORM}/.well-known/openid-configuration`;
const TOOL_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });

let available = false;
let platform;
let app;

function buildApp(envOverrides = {}) {
  const instance = express();
  instance.use('/api/lti', createLtiRouter({
    pool,
    env: { LTI_PUBLIC_URL: TOOL, LTI_REGISTRATION_SECRET: SECRET, LTI_TOOL_PRIVATE_KEY: TOOL_KEY, ...envOverrides },
    fetch: platform.fetch,
    getKeyResolver: platform.getKeyResolver,
  }));
  return instance;
}

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  platform = await createFakePlatform();
  app = buildApp();
});

test.beforeEach(async () => {
  if (!available) return;
  await truncateAll(pool);
  platform.calls.length = 0;
  platform.registrations.length = 0;
  platform.config.issuer = PLATFORM;
  platform.config.authorization_endpoint = `${PLATFORM}/auth`;
  platform.config.token_endpoint = `${PLATFORM}/token`;
  platform.config.jwks_uri = `${PLATFORM}/jwks`;
  platform.config.registration_endpoint = `${PLATFORM}/registration`;
  platform.registrationReply = { status: 200, body: { client_id: CLIENT_ID, [NS_TOOL]: { deployment_id: DEPLOYMENT_ID } } };
});

test.after(async () => {
  if (available) await truncateAll(pool);
  await pool.end();
});

function skipUnlessDb(t) {
  if (!available) {
    t.skip('no database reachable — set DB_HOST/DB_NAME to run integration tests');
    return true;
  }
  return false;
}

const register = (query = {}, target = app) => request(target).get('/api/lti/register').query({
  secret: SECRET,
  openid_configuration: CONFIG_URL,
  registration_token: REGISTRATION_TOKEN,
  ...query,
});

async function registrationCount() {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM lti_registrations')).rows[0].n;
}

async function assertRefused(res, status) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.match(res.body.error, UKRAINIAN);
  assert.equal(await registrationCount(), 0);
}

// ── The happy path ───────────────────────────────────

test('DW_4_2 dynamic registration against the fake platform stores a registration', async t => {
  if (skipUnlessDb(t)) return;

  const res = await register();

  assert.equal(res.status, 200, res.text);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.deepEqual(await getRegistration(PLATFORM, CLIENT_ID), REGISTRATION);
  assert.equal(await registrationCount(), 1);
});

test('DW_4_2 the page closes the platform window and carries its own CSP (nonce, issuer as frame ancestor)', async t => {
  if (skipUnlessDb(t)) return;

  const res = await register();

  assert.match(res.text, /org\.imsglobal\.lti\.close/);
  assert.match(res.text, /window\.opener \|\| window\.parent/);
  const csp = res.headers['content-security-policy'];
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, csp);
  assert.ok(res.text.includes(`<script nonce="${nonce}">`));
  assert.ok(csp.includes(`frame-ancestors ${PLATFORM}`));
  assert.ok(csp.startsWith("default-src 'none'"));
  assert.equal(csp.includes('unsafe-inline'), false);
  assert.equal(res.headers['x-frame-options'], undefined);
});

test('DW_4_2 the registration request names this tool, claims only iss and sub, and carries the token', async t => {
  if (skipUnlessDb(t)) return;

  await register();

  assert.equal(platform.registrations.length, 1);
  const body = platform.registrations[0];
  assert.equal(body.initiate_login_uri, `${TOOL}/api/lti/login`);
  assert.deepEqual(body.redirect_uris, [`${TOOL}/api/lti/launch`]);
  assert.equal(body.jwks_uri, `${TOOL}/api/lti/jwks`);
  assert.equal(body.token_endpoint_auth_method, 'private_key_jwt');
  assert.deepEqual(body.response_types, ['id_token']);
  assert.ok(body.grant_types.includes('client_credentials'));
  assert.match(body.scope, /lti-ags\/scope\/score/);
  assert.match(body.scope, /lti-ags\/scope\/lineitem/);

  const config = body[NS_TOOL];
  assert.equal(config.domain, 'tool.test');
  assert.equal(config.target_link_uri, `${TOOL}/api/lti/launch`);
  assert.deepEqual(config.claims, ['iss', 'sub']);
  assert.deepEqual(config.messages.map(m => m.type).sort(), ['LtiDeepLinkingRequest', 'LtiResourceLinkRequest']);
  for (const message of config.messages) assert.equal(message.target_link_uri, `${TOOL}/api/lti/launch`);

  const registrationCall = platform.calls.find(c => c.init.method === 'POST');
  assert.equal(registrationCall.init.headers.Authorization, `Bearer ${REGISTRATION_TOKEN}`);
});

test('DW_4_2 every outbound request refuses redirects and has a timeout', async t => {
  if (skipUnlessDb(t)) return;

  await register();

  assert.equal(platform.calls.length, 2);
  for (const { init } of platform.calls) {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test('DW_4_2 registering again for the same client refreshes the row instead of duplicating it', async t => {
  if (skipUnlessDb(t)) return;
  await register();
  platform.registrationReply.body[NS_TOOL].deployment_id = '2';
  platform.config.token_endpoint = `${PLATFORM}/token-v2`;

  assert.equal((await register()).status, 200);

  assert.equal(await registrationCount(), 1);
  const stored = await getRegistration(PLATFORM, CLIENT_ID);
  assert.deepEqual(stored.deploymentIds, ['2']);
  assert.equal(stored.authTokenUrl, `${PLATFORM}/token-v2`);
});

test('DW_4_2 a registration without a token still works for platforms that need none (no Authorization header)', async t => {
  if (skipUnlessDb(t)) return;
  const open = await createFakePlatform();
  open.fetch = async (url, init = {}) => {
    open.calls.push({ url, init });
    return url === CONFIG_URL
      ? new Response(JSON.stringify(platform.config), { status: 200 })
      : new Response(JSON.stringify(platform.registrationReply.body), { status: 200 });
  };
  const noToken = express();
  noToken.use('/api/lti', createLtiRouter({
    pool,
    env: { LTI_PUBLIC_URL: TOOL, LTI_REGISTRATION_SECRET: SECRET, LTI_TOOL_PRIVATE_KEY: TOOL_KEY },
    fetch: open.fetch,
  }));

  const res = await request(noToken).get('/api/lti/register').query({ secret: SECRET, openid_configuration: CONFIG_URL });

  assert.equal(res.status, 200);
  assert.equal(open.calls.find(c => c.init.method === 'POST').init.headers.Authorization, undefined);
});

// ── The secret guard ─────────────────────────────────

test('DW_4_2 without the secret registration is refused (401) and nothing is fetched', async t => {
  if (skipUnlessDb(t)) return;

  await assertRefused(await register({ secret: undefined }), 401);

  assert.equal(platform.calls.length, 0);
});

test('DW_4_2 with a wrong secret registration is refused (403) and nothing is fetched', async t => {
  if (skipUnlessDb(t)) return;

  for (const secret of ['wrong', SECRET + 'x', SECRET.slice(1), ['a', 'b']]) {
    await assertRefused(await register({ secret }), secret === 'wrong' || typeof secret === 'string' ? 403 : 401);
  }

  assert.equal(platform.calls.length, 0);
});

test('DW_4_2 when no registration secret is configured registration is closed (503)', async t => {
  if (skipUnlessDb(t)) return;
  const closed = buildApp({ LTI_REGISTRATION_SECRET: '' });

  await assertRefused(await register({}, closed), 503);

  assert.equal(platform.calls.length, 0);
});

test('DW_4_2 a registration secret shorter than 16 characters keeps registration closed (503) and is logged', async t => {
  if (skipUnlessDb(t)) return;
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));

  for (const short of ['a', 'x'.repeat(15)]) {
    const weak = buildApp({ LTI_REGISTRATION_SECRET: short });
    await assertRefused(await register({ secret: short }, weak), 503);
  }
  const ok = buildApp({ LTI_REGISTRATION_SECRET: 'x'.repeat(16) });
  assert.equal((await register({ secret: 'x'.repeat(16) }, ok)).status, 200);

  assert.equal(platform.calls.length, 2, 'only the 16-character secret reached the platform');
  assert.ok(logged.some(l => l.includes('[LTI]') && /shorter than 16/.test(l)));
  assert.equal(logged.join(' | ').includes('x'.repeat(15)), false, 'the secret itself is not logged');
});

// ── SSRF: https only, same host ──────────────────────

test('DW_4_2 an openid_configuration that is not a plain https URL is refused before any request', async t => {
  if (skipUnlessDb(t)) return;

  const bad = [
    'http://moodle.test/.well-known/openid-configuration',
    'ftp://moodle.test/config',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:pass@moodle.test/config',
    'not a url',
    '',
  ];
  for (const openid_configuration of bad) {
    await assertRefused(await register({ openid_configuration }), 400);
  }
  await assertRefused(await register({ openid_configuration: undefined }), 400);
  await assertRefused(await register({ openid_configuration: ['a', 'b'] }), 400);

  assert.equal(platform.calls.length, 0);
});

test('DW_4_2 a configuration whose issuer is on a foreign host is refused and the token is never sent', async t => {
  if (skipUnlessDb(t)) return;
  platform.config.issuer = 'https://evil.test';

  await assertRefused(await register(), 400);

  assert.equal(platform.calls.length, 1, 'only the configuration was fetched');
  assert.equal(platform.registrations.length, 0);
});

test('DW_4_2 a registration endpoint on a foreign host is refused (the token would leak)', async t => {
  if (skipUnlessDb(t)) return;
  platform.config.registration_endpoint = 'https://evil.test/registration';

  await assertRefused(await register(), 400);

  assert.equal(platform.calls.length, 1);
});

test('DW_4_2 a non-https endpoint in the configuration is refused', async t => {
  if (skipUnlessDb(t)) return;

  for (const key of ['registration_endpoint', 'authorization_endpoint', 'token_endpoint', 'jwks_uri', 'issuer']) {
    const original = platform.config[key];
    platform.config[key] = original.replace('https://', 'http://');
    await assertRefused(await register(), 400);
    platform.config[key] = original;
  }
});

test('DW_4_2 authorization, token and jwks endpoints on a foreign host are refused', async t => {
  if (skipUnlessDb(t)) return;

  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const original = platform.config[key];
    platform.config[key] = 'https://evil.test/x';
    await assertRefused(await register(), 400);
    platform.config[key] = original;
  }
  assert.equal(platform.registrations.length, 0, 'the registration token was never sent');
});

test('DW_4_2 a configuration missing an endpoint is refused', async t => {
  if (skipUnlessDb(t)) return;
  delete platform.config.jwks_uri;

  await assertRefused(await register(), 400);
});

// ── Platform misbehaviour ────────────────────────────

test('DW_4_2 a platform that errors, lies or hangs yields 502 and stores nothing', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('registration endpoint answers 400', async () => {
    platform.registrationReply = { status: 400, body: { error: 'invalid_client_metadata' } };
    await assertRefused(await register(), 502);
  });

  await t.test('registration response lacks client_id', async () => {
    platform.registrationReply = { status: 200, body: { [NS_TOOL]: { deployment_id: '1' } } };
    await assertRefused(await register(), 502);
  });

  await t.test('registration response lacks deployment_id', async () => {
    platform.registrationReply = { status: 200, body: { client_id: CLIENT_ID } };
    await assertRefused(await register(), 502);
  });

  await t.test('registration response is not JSON', async () => {
    platform.registrationReply = { status: 200, body: '<html>oops</html>' };
    await assertRefused(await register(), 502);
  });

  await t.test('registration response is oversized', async () => {
    platform.registrationReply = { status: 200, body: JSON.stringify({ client_id: 'x'.repeat(300 * 1024) }) };
    await assertRefused(await register(), 502);
  });

  await t.test('the platform is unreachable (fetch rejects, e.g. on a redirect)', async () => {
    const failing = express();
    failing.use('/api/lti', createLtiRouter({
      pool,
      env: { LTI_PUBLIC_URL: TOOL, LTI_REGISTRATION_SECRET: SECRET, LTI_TOOL_PRIVATE_KEY: TOOL_KEY },
      fetch: async () => { throw new TypeError('fetch failed'); },
    }));
    await assertRefused(await register({}, failing), 502);
  });

  await t.test('the configuration endpoint answers 404', async () => {
    await assertRefused(await register({ openid_configuration: `${PLATFORM}/missing` }), 502);
  });
});

test('DW_4_2 the secret and the registration token never reach the log', async t => {
  if (skipUnlessDb(t)) return;
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => lines.push(args.join(' '));
  try {
    await register();
    await register({ secret: 'wrong' });
    platform.config.issuer = 'https://evil.test';
    await register();
  } finally {
    Object.assign(console, original);
  }

  const output = lines.join('\n');
  assert.ok(output.includes('[LTI]'));
  assert.equal(output.includes(SECRET), false);
  assert.equal(output.includes(REGISTRATION_TOKEN), false);
});
