// backend/test/integration/lti-launch.test.js
//
// Phase 4 (LTI): OIDC login, launch validation, the server-side session and the JWKS, against a fake
// Moodle (own RSA keys) and a real Postgres. Covers DW-4.1, DW-4.3 and the error-body half of DW-4.5.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const request = require('supertest');
const { createLocalJWKSet, jwtVerify } = require('jose');

const { pool } = require('../../server');
const { createLtiRouter, getRegistration, signToolJwt, requireLtiSession } = require('../../lti');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const {
  PLATFORM, TOOL, LAUNCH_URL, CLIENT_ID, DEPLOYMENT_ID, REGISTRATION, CLAIM, LEARNER, INSTRUCTOR,
  createFakePlatform, resourceClaims, deepLinkClaims, unsignedToken,
} = require('../helpers/fake-platform');

const UKRAINIAN = /[А-Яа-яІіЇїЄєҐґ]/;
const TOOL_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });

let available = false;
let platform;
let app;

function buildApp(envOverrides = {}) {
  const instance = express();
  instance.use('/api/lti', createLtiRouter({
    pool,
    env: { LTI_PUBLIC_URL: TOOL, LTI_TOOL_PRIVATE_KEY: TOOL_KEY, ...envOverrides },
    fetch: platform.fetch,
    getKeyResolver: platform.getKeyResolver,
  }));
  instance.get('/whoami', requireLtiSession, (req, res) => res.json(req.lti));
  return instance;
}

async function saveRegistration(r = REGISTRATION) {
  await pool.query(`
    INSERT INTO lti_registrations (issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_uri)
    VALUES ($1, $2, $3, $4, $5, $6)`,
  [r.issuer, r.clientId, r.deploymentIds, r.authLoginUrl, r.authTokenUrl, r.jwksUri]);
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
  await saveRegistration();
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

const LOGIN_PARAMS = {
  iss: PLATFORM,
  login_hint: 'hint-1',
  target_link_uri: LAUNCH_URL,
  client_id: CLIENT_ID,
  lti_deployment_id: DEPLOYMENT_ID,
  lti_message_hint: 'message-hint-1',
};

/** Runs the OIDC initiation and returns what the browser would hold: state, nonce and the state cookie. */
async function login(overrides = {}) {
  const res = await request(app).get('/api/lti/login').query({ ...LOGIN_PARAMS, ...overrides });
  assert.equal(res.status, 302, JSON.stringify(res.body));
  const location = new URL(res.headers.location);
  const stateCookie = res.headers['set-cookie'].find(c => c.startsWith('lti_state_'));
  return {
    res,
    location,
    state: location.searchParams.get('state'),
    nonce: location.searchParams.get('nonce'),
    cookie: stateCookie.split(';')[0],
  };
}

const postLaunch = ({ token, state, cookie }) => {
  const req = request(app).post('/api/lti/launch').type('form');
  if (cookie) req.set('Cookie', cookie);
  return req.send({ ...(token ? { id_token: token } : {}), ...(state ? { state } : {}) });
};

async function sessionCount() {
  return (await pool.query('SELECT COUNT(*)::int AS n FROM lti_sessions')).rows[0].n;
}

/** The common shape of every rejection: status, `{ error }` in Ukrainian, no session cookie, no session row. */
async function assertRejected(res, status) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.match(res.body.error, UKRAINIAN);
  assert.equal((res.headers['set-cookie'] || []).some(c => c.startsWith('lti_session=')), false);
  assert.equal(await sessionCount(), 0);
}

/** Login + signed launch of `claims`; `tweak` may replace the token. */
async function launchWith(buildClaims, { sign = {}, tweakToken } = {}) {
  const flow = await login();
  const claims = typeof buildClaims === 'function' ? buildClaims(flow.nonce) : buildClaims;
  let token = await platform.sign(claims, sign);
  if (tweakToken) token = tweakToken(token, claims);
  return postLaunch({ token, state: flow.state, cookie: flow.cookie });
}

// ── Login (OIDC initiation) ──────────────────────────

test('DW_4_1 login redirects to the platform with state, nonce and the exact OIDC parameters', async t => {
  if (skipUnlessDb(t)) return;

  const { location, state, nonce, res } = await login();

  assert.equal(location.origin + location.pathname, `${PLATFORM}/auth`);
  const p = location.searchParams;
  assert.equal(p.get('scope'), 'openid');
  assert.equal(p.get('response_type'), 'id_token');
  assert.equal(p.get('response_mode'), 'form_post');
  assert.equal(p.get('prompt'), 'none');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), LAUNCH_URL);
  assert.equal(p.get('login_hint'), 'hint-1');
  assert.equal(p.get('lti_message_hint'), 'message-hint-1');
  assert.ok(state.length >= 40 && nonce.length >= 40 && state !== nonce);

  const rows = (await pool.query('SELECT * FROM lti_states')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, state);
  assert.equal(rows[0].nonce, nonce);

  const cookie = res.headers['set-cookie'].find(c => c.startsWith('lti_state_'));
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; SameSite=None/);
  assert.match(cookie, /; Partitioned$/);
  assert.match(cookie, /; Path=\/api\/lti/);
});

test('DW_4_1 login also accepts a form POST and works without client_id when the issuer has one registration', async t => {
  if (skipUnlessDb(t)) return;

  const { client_id: _omitted, ...withoutClient } = LOGIN_PARAMS;
  const res = await request(app).post('/api/lti/login').type('form').send(withoutClient);

  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.location).searchParams.get('client_id'), CLIENT_ID);
});

test('DW_4_1 login keeps query parameters already present on the platform auth URL', async t => {
  if (skipUnlessDb(t)) return;
  await pool.query(`UPDATE lti_registrations SET auth_login_url = $1`, [`${PLATFORM}/auth?tenant=7`]);

  const { location } = await login();

  assert.equal(location.searchParams.get('tenant'), '7');
  assert.equal(location.searchParams.get('scope'), 'openid');
});

test('DW_4_1 login rejects bad requests with 4xx and stores no state', async t => {
  if (skipUnlessDb(t)) return;

  const cases = [
    ['missing iss', { iss: undefined }, 400],
    ['missing login_hint', { login_hint: undefined }, 400],
    ['missing target_link_uri', { target_link_uri: undefined }, 400],
    ['non-string parameter (array)', { login_hint: ['a', 'b'] }, 400],
    ['unknown issuer', { iss: 'https://evil.test' }, 403],
    ['unknown client_id', { client_id: 'other-client' }, 403],
    ['unknown deployment hint', { lti_deployment_id: '999' }, 403],
    ['target_link_uri on a foreign origin', { target_link_uri: 'https://evil.test/api/lti/launch' }, 400],
    ['target_link_uri over http', { target_link_uri: 'http://tool.test/api/lti/launch' }, 400],
    ['target_link_uri not a URL', { target_link_uri: 'not a url' }, 400],
  ];

  for (const [name, overrides, status] of cases) {
    await t.test(name, async () => {
      const res = await request(app).get('/api/lti/login').query({ ...LOGIN_PARAMS, ...overrides });
      assert.equal(res.status, status, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body), ['error']);
      assert.match(res.body.error, UKRAINIAN);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM lti_states')).rows[0].n, 0);
      assert.equal(res.headers['set-cookie'], undefined);
    });
  }
});

test('DW_4_1 login without client_id is refused when the issuer has several registrations', async t => {
  if (skipUnlessDb(t)) return;
  await saveRegistration({ ...REGISTRATION, clientId: 'client-2' });

  const { client_id: _omitted, ...withoutClient } = LOGIN_PARAMS;
  const res = await request(app).get('/api/lti/login').query(withoutClient);

  assert.equal(res.status, 400);
  assert.match(res.body.error, UKRAINIAN);
});

test('login prunes expired states and sessions', async t => {
  if (skipUnlessDb(t)) return;
  await pool.query(`INSERT INTO lti_states (state, nonce, issuer, client_id, target_link_uri, expires_at)
                    VALUES ('old', 'n', $1, $2, $3, NOW() - INTERVAL '1 hour')`, [PLATFORM, CLIENT_ID, LAUNCH_URL]);
  await pool.query(`INSERT INTO lti_sessions (id, issuer, client_id, deployment_id, sub, role, message_type, expires_at)
                    VALUES ('old', $1, $2, '1', 's', 'learner', 'resource', NOW() - INTERVAL '1 hour')`, [PLATFORM, CLIENT_ID]);

  await login();

  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM lti_states WHERE state = 'old'`)).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM lti_sessions WHERE id = 'old'`)).rows[0].n, 0);
});

// ── Launch: the happy paths ──────────────────────────

test('DW_4_1 a valid resource launch opens a session and redirects into the player', async t => {
  if (skipUnlessDb(t)) return;

  const flow = await login();
  const token = await platform.sign(resourceClaims(flow.nonce));
  const res = await postLaunch({ token, state: flow.state, cookie: flow.cookie });

  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/play/circuits?lti=1');

  const sessionCookie = res.headers['set-cookie'].find(c => c.startsWith('lti_session='));
  assert.ok(sessionCookie);
  const whoami = await request(app).get('/whoami').set('Cookie', sessionCookie.split(';')[0]);

  assert.equal(whoami.status, 200);
  assert.deepEqual(Object.keys(whoami.body).sort(), [
    'clientId', 'contextId', 'deepLinkData', 'deepLinkReturnUrl', 'deploymentId', 'id', 'issuer',
    'lineitemUrl', 'messageType', 'resourceLinkId', 'role', 'scenarioId', 'sub',
  ]);
  assert.deepEqual({ ...whoami.body, id: undefined }, {
    id: undefined,
    issuer: PLATFORM,
    clientId: CLIENT_ID,
    deploymentId: DEPLOYMENT_ID,
    sub: 'user-1',
    role: 'learner',
    contextId: 'course-1',
    resourceLinkId: 'rl-1',
    lineitemUrl: `${PLATFORM}/lineitem/7`,
    scenarioId: 'circuits',
    messageType: 'resource',
    deepLinkReturnUrl: null,
    deepLinkData: null,
  });
});

test('DW_4_1 the used state is gone: replaying the same launch is refused and opens no second session', async t => {
  if (skipUnlessDb(t)) return;

  const flow = await login();
  const token = await platform.sign(resourceClaims(flow.nonce));
  const first = await postLaunch({ token, state: flow.state, cookie: flow.cookie });
  assert.equal(first.status, 303);

  const replay = await postLaunch({ token, state: flow.state, cookie: flow.cookie });

  assert.equal(replay.status, 403);
  assert.match(replay.body.error, UKRAINIAN);
  assert.equal(await sessionCount(), 1);
});

test('DW_4_1 the launch clears the state cookie it used', async t => {
  if (skipUnlessDb(t)) return;

  const res = await launchWith(nonce => resourceClaims(nonce));

  const cleared = res.headers['set-cookie'].find(c => c.startsWith('lti_state_'));
  assert.match(cleared, /Max-Age=0/);
  // A partitioned cookie is cleared only by a header that is itself Partitioned.
  assert.match(cleared, /; Partitioned$/);
  assert.match(cleared, /; Path=\/api\/lti/);
});

test('DW_4_1 an instructor role is recognised, a learner stays learner, no roles means learner', async t => {
  if (skipUnlessDb(t)) return;

  const roleOf = async roles => {
    const res = await launchWith(nonce => resourceClaims(nonce, { [`${CLAIM}roles`]: roles }));
    assert.equal(res.status, 303);
    return (await pool.query('SELECT role FROM lti_sessions')).rows[0].role;
  };

  assert.equal(await roleOf([INSTRUCTOR]), 'instructor');
  await truncateAll(pool); await saveRegistration();
  assert.equal(await roleOf([LEARNER, 'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator']), 'instructor');
  await truncateAll(pool); await saveRegistration();
  assert.equal(await roleOf([LEARNER]), 'learner');
  await truncateAll(pool); await saveRegistration();
  assert.equal(await roleOf([]), 'learner');
});

test('DW_4_1 the scenario comes from the target link when there is no custom parameter', async t => {
  if (skipUnlessDb(t)) return;
  const target = `${TOOL}/play/solar-system`;

  const flow = await login({ target_link_uri: target });
  const token = await platform.sign(resourceClaims(flow.nonce, {
    [`${CLAIM}target_link_uri`]: target,
    [`${CLAIM}custom`]: undefined,
  }));
  const res = await postLaunch({ token, state: flow.state, cookie: flow.cookie });

  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/play/solar-system?lti=1');
});

test('DW_4_1 a resource launch without a line item still opens a session (not graded)', async t => {
  if (skipUnlessDb(t)) return;

  const res = await launchWith(nonce => resourceClaims(nonce, {
    'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint': undefined,
  }));

  assert.equal(res.status, 303);
  assert.equal((await pool.query('SELECT lineitem_url FROM lti_sessions')).rows[0].lineitem_url, null);
});

test('DW_4_1 a valid deep-linking launch redirects to the picker and keeps the return data', async t => {
  if (skipUnlessDb(t)) return;

  const res = await launchWith(nonce => deepLinkClaims(nonce));

  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/lti/pick');
  const sessionCookie = res.headers['set-cookie'].find(c => c.startsWith('lti_session=')).split(';')[0];
  const whoami = (await request(app).get('/whoami').set('Cookie', sessionCookie)).body;
  assert.equal(whoami.messageType, 'deep-link');
  assert.equal(whoami.role, 'instructor');
  assert.equal(whoami.deepLinkReturnUrl, `${PLATFORM}/deeplink/return`);
  assert.equal(whoami.deepLinkData, 'opaque-data-1');
  assert.equal(whoami.resourceLinkId, null);
  assert.equal(whoami.scenarioId, null);
});

test('DW_4_1 an aud list is accepted when azp names this client', async t => {
  if (skipUnlessDb(t)) return;

  const res = await launchWith(nonce => resourceClaims(nonce, { aud: [CLIENT_ID, 'other'], azp: CLIENT_ID }));

  assert.equal(res.status, 303);
});

// ── Launch: every edge case is a 4xx with no session ─

test('DW_4_1 forged, malformed and out-of-policy tokens are rejected without a session', async t => {
  if (skipUnlessDb(t)) return;

  const cases = [
    ['signed by an unknown key (same kid)', 401, { sign: nonce => ({ key: platform.forgingKey }) }, nonce => resourceClaims(nonce)],
    ['unsigned (alg none)', 401, { tweakToken: (_, claims) => unsignedToken(claims) }, nonce => resourceClaims(nonce)],
    ['HS256 instead of RS256', 401, { sign: () => ({ alg: 'HS256', key: new TextEncoder().encode('x'.repeat(32)) }) }, nonce => resourceClaims(nonce)],
    ['payload tampered after signing', 401, {
      tweakToken: token => {
        const [h, , s] = token.split('.');
        const forged = Buffer.from(JSON.stringify({ ...resourceClaims('x'), sub: 'admin' })).toString('base64url');
        return `${h}.${forged}.${s}`;
      },
    }, nonce => resourceClaims(nonce)],
    ['garbage instead of a JWT', 401, { tweakToken: () => 'not.a.jwt' }, nonce => resourceClaims(nonce)],
    ['expired', 401, { sign: () => ({ exp: Math.floor(Date.now() / 1000) - 3600 }) }, nonce => resourceClaims(nonce)],
    ['no exp claim', 401, { sign: () => ({ exp: null }) }, nonce => resourceClaims(nonce)],
    ['wrong iss', 401, {}, nonce => resourceClaims(nonce, { iss: 'https://evil.test' })],
    ['wrong aud', 401, {}, nonce => resourceClaims(nonce, { aud: 'someone-else' })],
    ['aud list without azp', 401, {}, nonce => resourceClaims(nonce, { aud: [CLIENT_ID, 'other'] })],
    ['aud list with a foreign azp', 401, {}, nonce => resourceClaims(nonce, { aud: [CLIENT_ID, 'other'], azp: 'other' })],
    ['nonce differs from the login', 401, {}, () => resourceClaims('some-other-nonce')],
    ['no nonce', 401, {}, nonce => resourceClaims(nonce, { nonce: undefined })],
    ['wrong deployment_id', 403, {}, nonce => resourceClaims(nonce, { [`${CLAIM}deployment_id`]: '999' })],
    ['missing deployment_id', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}deployment_id`]: undefined })],
    ['missing message type', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}message_type`]: undefined })],
    ['unsupported message type', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}message_type`]: 'LtiSubmissionReviewRequest' })],
    ['missing version', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}version`]: undefined })],
    ['wrong version', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}version`]: '1.1.0' })],
    ['missing sub (required claim)', 401, {}, nonce => resourceClaims(nonce, { sub: undefined })],
    ['missing target_link_uri claim', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}target_link_uri`]: undefined })],
    ['target_link_uri differs from the login', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}target_link_uri`]: `${TOOL}/other` })],
    ['resource launch without resource_link', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}resource_link`]: undefined })],
    ['resource launch without resource_link.id', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}resource_link`]: {} })],
    ['resource launch with no scenario anywhere', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}custom`]: {} })],
    ['resource launch with an unsafe scenario id', 400, {}, nonce => resourceClaims(nonce, { [`${CLAIM}custom`]: { scenario_id: '../../etc' } })],
    ['deep-link without settings', 400, {}, nonce => deepLinkClaims(nonce, { 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings': undefined })],
    ['deep-link with a non-https return url', 400, {}, nonce => deepLinkClaims(nonce, {
      'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings': { deep_link_return_url: 'http://moodle.test/return' },
    })],
  ];

  for (const [name, status, options, buildClaims] of cases) {
    await t.test(name, async () => {
      const flow = await login();
      const claims = buildClaims(flow.nonce);
      const signOptions = typeof options.sign === 'function' ? options.sign() : {};
      let token = await platform.sign(claims, signOptions);
      if (options.tweakToken) token = options.tweakToken(token, claims);

      await assertRejected(await postLaunch({ token, state: flow.state, cookie: flow.cookie }), status);
    });
  }
});

test('DW_4_1 requests without a usable state cookie are refused, and a refusal does not burn the state', async t => {
  if (skipUnlessDb(t)) return;

  const flow = await login();
  const token = await platform.sign(resourceClaims(flow.nonce));

  // state cookie absent on the launch POST
  await assertRejected(await postLaunch({ token, state: flow.state }), 403);

  // state cookie holds another value
  const wrong = `${flow.cookie.split('=')[0]}=${'x'.repeat(flow.state.length)}`;
  await assertRejected(await postLaunch({ token, state: flow.state, cookie: wrong }), 403);

  // the cookie of a different login does not satisfy this state
  const other = await login();
  await assertRejected(await postLaunch({ token, state: flow.state, cookie: other.cookie }), 403);

  // a third party's failed attempts left the state usable for the real browser
  const res = await postLaunch({ token, state: flow.state, cookie: flow.cookie });
  assert.equal(res.status, 303);
});

test('DW_4_1 unknown, expired and missing states and tokens are refused', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('unknown state', async () => {
    const token = await platform.sign(resourceClaims('n'));
    await assertRejected(await postLaunch({ token, state: 'nope', cookie: 'lti_state_nope=nope' }), 403);
  });

  await t.test('expired state', async () => {
    const flow = await login();
    await pool.query(`UPDATE lti_states SET expires_at = NOW() - INTERVAL '1 second'`);
    const token = await platform.sign(resourceClaims(flow.nonce));
    await assertRejected(await postLaunch({ token, state: flow.state, cookie: flow.cookie }), 403);
  });

  await t.test('missing id_token', async () => {
    const flow = await login();
    await assertRejected(await postLaunch({ state: flow.state, cookie: flow.cookie }), 400);
  });

  await t.test('missing state', async () => {
    const flow = await login();
    const token = await platform.sign(resourceClaims(flow.nonce));
    await assertRejected(await postLaunch({ token, cookie: flow.cookie }), 400);
  });

  await t.test('the registration disappeared between login and launch', async () => {
    const flow = await login();
    await pool.query('DELETE FROM lti_registrations');
    const token = await platform.sign(resourceClaims(flow.nonce));
    await assertRejected(await postLaunch({ token, state: flow.state, cookie: flow.cookie }), 403);
  });
});

test('DW_4_1 a platform whose key set cannot be fetched gives 502, not a session', async t => {
  if (skipUnlessDb(t)) return;
  const failing = express();
  failing.use('/api/lti', createLtiRouter({
    pool,
    env: { LTI_PUBLIC_URL: TOOL, LTI_TOOL_PRIVATE_KEY: TOOL_KEY },
    fetch: platform.fetch,
    getKeyResolver: () => async () => { throw new TypeError('fetch failed'); },
  }));
  const saved = app;
  app = failing;
  try {
    const flow = await login();
    const token = await platform.sign(resourceClaims(flow.nonce));
    await assertRejected(await postLaunch({ token, state: flow.state, cookie: flow.cookie }), 502);
  } finally {
    app = saved;
  }
});

test('an oversized launch body is a JSON 413 and a malformed one a JSON 400', async t => {
  if (skipUnlessDb(t)) return;

  const big = await request(app).post('/api/lti/launch').type('form').send({ id_token: 'x'.repeat(200 * 1024) });
  assert.equal(big.status, 413);
  assert.deepEqual(big.body, { error: 'Запит завеликий' });

  const broken = await request(app).post('/api/lti/launch')
    .set('Content-Type', 'application/x-www-form-urlencoded; charset=nope').send('a=b');
  assert.equal(broken.status, 400);
  assert.match(broken.body.error, UKRAINIAN);
});

test('DW_4_1 with no injected resolver the production JWKS fetch verifies a launch (and fetches the key set once)', async t => {
  if (skipUnlessDb(t)) return;
  let hits = 0;
  const jwksServer = http.createServer((req, res) => {
    hits++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(platform.jwks));
  });
  await new Promise(resolve => jwksServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => jwksServer.close(resolve)));
  await pool.query('UPDATE lti_registrations SET jwks_uri = $1', [`http://127.0.0.1:${jwksServer.address().port}/jwks`]);

  const real = express();
  real.use('/api/lti', createLtiRouter({ pool, env: { LTI_PUBLIC_URL: TOOL, LTI_TOOL_PRIVATE_KEY: TOOL_KEY } }));
  const saved = app;
  app = real;
  try {
    const first = await launchWith(nonce => resourceClaims(nonce));
    assert.equal(first.status, 303, JSON.stringify(first.body));
    const second = await launchWith(nonce => resourceClaims(nonce));
    assert.equal(second.status, 303);
    assert.equal(hits, 1, 'the second launch reuses the cached key set');

    // The real resolver still rejects a token signed by someone else.
    await pool.query('TRUNCATE lti_sessions');
    const forged = await launchWith(nonce => resourceClaims(nonce), { sign: { key: platform.forgingKey } });
    assert.equal(forged.status, 401);
    assert.equal(await sessionCount(), 0);
  } finally {
    app = saved;
  }
});

// ── Session (DW-4.3) ─────────────────────────────────

test('DW_4_3 the session cookie is SameSite=None; Secure; HttpOnly and never holds the stored id', async t => {
  if (skipUnlessDb(t)) return;

  const res = await launchWith(nonce => resourceClaims(nonce));

  const cookie = res.headers['set-cookie'].find(c => c.startsWith('lti_session='));
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; SameSite=None/);
  assert.match(cookie, /; Partitioned$/);
  assert.match(cookie, /; Path=\/(;|$)/);
  assert.match(cookie, /; Max-Age=14400/);

  const token = cookie.split(';')[0].split('=')[1];
  const { rows } = await pool.query('SELECT id FROM lti_sessions');
  assert.notEqual(rows[0].id, token);
  assert.equal(rows[0].id, crypto.createHash('sha256').update(token).digest('hex'));
});

test('DW_4_3 session rows hold no name and no e-mail, even when the token carries them', async t => {
  if (skipUnlessDb(t)) return;

  const res = await launchWith(nonce => resourceClaims(nonce, {
    given_name: 'Іван', family_name: 'Петренко', 'https://purl.imsglobal.org/spec/lti/claim/lis': { person_sourcedid: 'sis-77' },
  }));
  assert.equal(res.status, 303);

  const columns = (await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_name IN ('lti_registrations', 'lti_states', 'lti_sessions')`)).rows;
  assert.ok(columns.length > 0);
  assert.deepEqual(columns.filter(c => /name|mail|given|family|picture|phone/i.test(c.column_name)
    && c.column_name !== 'client_id'), []);

  const dump = JSON.stringify((await pool.query(`
    SELECT row_to_json(s) AS r FROM lti_sessions s
    UNION ALL SELECT row_to_json(t) FROM lti_states t`)).rows);
  for (const secret of ['Іван', 'Петренко', 'ivan@moodle.test', 'sis-77']) {
    assert.equal(dump.includes(secret), false, `${secret} leaked into the database`);
  }
});

test('DW_4_3 an expired session is 401, so are an absent cookie and an unknown token', async t => {
  if (skipUnlessDb(t)) return;

  const res = await launchWith(nonce => resourceClaims(nonce));
  const cookie = res.headers['set-cookie'].find(c => c.startsWith('lti_session=')).split(';')[0];
  assert.equal((await request(app).get('/whoami').set('Cookie', cookie)).status, 200);

  await pool.query(`UPDATE lti_sessions SET expires_at = NOW() - INTERVAL '1 second'`);
  const expired = await request(app).get('/whoami').set('Cookie', cookie);
  assert.equal(expired.status, 401);
  assert.match(expired.body.error, UKRAINIAN);
  assert.deepEqual(Object.keys(expired.body), ['error']);

  const absent = await request(app).get('/whoami');
  assert.equal(absent.status, 401);
  assert.match(absent.body.error, UKRAINIAN);

  const unknown = await request(app).get('/whoami').set('Cookie', 'lti_session=forged');
  assert.equal(unknown.status, 401);
});

test('LTI_SESSION_TTL_SECONDS sets the cookie and the row lifetime', async t => {
  if (skipUnlessDb(t)) return;
  const saved = app;
  app = buildApp({ LTI_SESSION_TTL_SECONDS: '120' });
  try {
    const res = await launchWith(nonce => resourceClaims(nonce));
    assert.match(res.headers['set-cookie'].find(c => c.startsWith('lti_session=')), /Max-Age=120/);
    const { rows } = await pool.query(`SELECT expires_at - created_at AS ttl FROM lti_sessions`);
    assert.equal(rows[0].ttl.minutes, 2, JSON.stringify(rows[0].ttl));
  } finally {
    app = saved;
  }
});

test('DW_4_3 truncateAll clears the LTI tables', async t => {
  if (skipUnlessDb(t)) return;
  await launchWith(nonce => resourceClaims(nonce));
  await login();

  await truncateAll(pool);

  for (const table of ['lti_registrations', 'lti_states', 'lti_sessions']) {
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
  }
});

// ── Exports: JWKS, signToolJwt, getRegistration ──────

test('GET /jwks publishes the tool public key (RS256, kid) and never the private part', async t => {
  if (skipUnlessDb(t)) return;

  const res = await request(app).get('/api/lti/jwks');

  assert.equal(res.status, 200);
  assert.equal(res.body.keys.length, 1);
  const [key] = res.body.keys;
  assert.equal(key.kty, 'RSA');
  assert.equal(key.alg, 'RS256');
  assert.ok(key.kid);
  for (const privatePart of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.equal(key[privatePart], undefined);
  assert.match(res.headers['cache-control'], /public/);
});

test('signToolJwt signs RS256 with the published kid; the JWKS verifies it', async t => {
  if (skipUnlessDb(t)) return;

  const jwks = (await request(app).get('/api/lti/jwks')).body;
  const token = await signToolJwt({ iss: CLIENT_ID, sub: CLIENT_ID, aud: `${PLATFORM}/token`, jti: 'j1' });

  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), { audience: `${PLATFORM}/token` });
  assert.equal(protectedHeader.alg, 'RS256');
  assert.equal(protectedHeader.kid, jwks.keys[0].kid);
  assert.equal(payload.iss, CLIENT_ID);
  assert.ok(payload.exp > payload.iat, 'iat and exp are added when the caller gives none');
});

test('getRegistration returns the Registration shape, or null for an unknown pair', async t => {
  if (skipUnlessDb(t)) return;

  assert.deepEqual(await getRegistration(PLATFORM, CLIENT_ID), REGISTRATION);
  assert.equal(await getRegistration(PLATFORM, 'nope'), null);
  assert.equal(await getRegistration('https://other.test', CLIENT_ID), null);
});

// ── Router-level behaviour ───────────────────────────

test('every LTI response carries a locked-down CSP and no-store; JSON errors keep the {error} shape', async t => {
  if (skipUnlessDb(t)) return;

  const jwks = await request(app).get('/api/lti/jwks');
  const rejected = await request(app).get('/api/lti/login');

  for (const res of [jwks, rejected]) {
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
    assert.equal(res.headers['cache-control'].includes('no-store') || res.headers['cache-control'].includes('public'), true);
  }
  assert.equal(rejected.status, 400);
  assert.deepEqual(Object.keys(rejected.body), ['error']);
});

test('without LTI_PUBLIC_URL every LTI endpoint answers 503 {error}', async t => {
  if (skipUnlessDb(t)) return;
  const saved = app;
  app = buildApp({ LTI_PUBLIC_URL: '' });
  try {
    for (const [method, path] of [['get', '/api/lti/jwks'], ['get', '/api/lti/login'], ['post', '/api/lti/launch'], ['get', '/api/lti/register']]) {
      const res = await request(app)[method](path);
      assert.equal(res.status, 503, path);
      assert.match(res.body.error, UKRAINIAN);
    }
  } finally {
    app = saved;
  }
});

test('an http LTI_PUBLIC_URL counts as not configured (HTTPS only)', async t => {
  if (skipUnlessDb(t)) return;
  const saved = app;
  app = buildApp({ LTI_PUBLIC_URL: 'http://tool.test' });
  try {
    assert.equal((await request(app).get('/api/lti/jwks')).status, 503);
  } finally {
    app = saved;
  }
});

test('the LTI endpoints are rate limited with a JSON 429', async t => {
  if (skipUnlessDb(t)) return;
  const saved = app;
  app = buildApp({ LTI_RATE_LIMIT: '2' });
  try {
    assert.equal((await request(app).get('/api/lti/jwks')).status, 200);
    assert.equal((await request(app).get('/api/lti/jwks')).status, 200);
    const limited = await request(app).get('/api/lti/jwks');
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, UKRAINIAN);
  } finally {
    app = saved;
  }
});

test('a database failure during launch is a logged 500 {error}, not a leak', async t => {
  if (skipUnlessDb(t)) return;
  const flow = await login();
  const token = await platform.sign(resourceClaims(flow.nonce));
  await pool.query('ALTER TABLE lti_sessions RENAME TO lti_sessions_off');
  try {
    const res = await postLaunch({ token, state: flow.state, cookie: flow.cookie });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Помилка сервера' });
  } finally {
    await pool.query('ALTER TABLE lti_sessions_off RENAME TO lti_sessions');
  }
});
