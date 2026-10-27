// backend/test/integration/lti-grades.test.js
//
// Phase 5 (LTI): Deep Linking response, session state and grade passback, against a fake Moodle (own RSA keys,
// token endpoint, AGS Results and Scores) and a real Postgres. Covers DW-5.1, DW-5.2 and the edge cases of DW-5.3.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { createLocalJWKSet, jwtVerify } = require('jose');

const { pool } = require('../../server');
const { createLtiRouter } = require('../../lti');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const {
  PLATFORM, TOOL, CLIENT_ID, DEPLOYMENT_ID, REGISTRATION, CLAIM, LINEITEM,
  createFakePlatform,
} = require('../helpers/fake-platform');

const UKRAINIAN = /[А-Яа-яІіЇїЄєҐґ]/;
const DL = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
const TOOL_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });
const RETURN_URL = `${PLATFORM}/deeplink/return`;

let available = false;
let platform;
let app;
let toolJwks;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  platform = await createFakePlatform();
  const instance = express();
  instance.use('/api/lti', createLtiRouter({
    pool,
    env: { LTI_PUBLIC_URL: TOOL, LTI_TOOL_PRIVATE_KEY: TOOL_KEY },
    fetch: platform.fetch,
    getKeyResolver: platform.getKeyResolver,
  }));
  app = instance;
  toolJwks = createLocalJWKSet((await request(app).get('/api/lti/jwks')).body);
});

test.beforeEach(async () => {
  if (!available) return;
  await truncateAll(pool);
  await pool.query(`
    INSERT INTO lti_registrations (issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_uri)
    VALUES ($1, $2, $3, $4, $5, $6)`,
  [REGISTRATION.issuer, REGISTRATION.clientId, REGISTRATION.deploymentIds, REGISTRATION.authLoginUrl,
    REGISTRATION.authTokenUrl, REGISTRATION.jwksUri]);
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, scenario_url, is_published, graded) VALUES
      ('circuits', 'Електричні кола', 'physics', 'Фізика', '/scenarios/a.zip', true, true),
      ('solar-system', 'Сонячна система & <планети>', 'astronomy', 'Астрономія', '/scenarios/b.zip', true, false),
      ('hidden-lab', 'Прихована', 'physics', 'Фізика', '/scenarios/c.zip', false, true)`);
  const { ags } = platform;
  ags.token = { status: 200, body: { access_token: 'ags-token-1', token_type: 'Bearer', expires_in: 3600 } };
  ags.results = { status: 200, body: [] };
  ags.score = { status: 200, body: {} };
  ags.tokenRequests.length = 0;
  ags.resultRequests.length = 0;
  ags.scores.length = 0;
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

/** Inserts a session row as a completed launch would and returns the cookie header for it. */
async function makeSession(overrides = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const s = {
    issuer: PLATFORM, clientId: CLIENT_ID, deploymentId: DEPLOYMENT_ID, sub: 'user-1', role: 'learner',
    contextId: 'course-1', resourceLinkId: 'rl-1', lineitemUrl: LINEITEM, scenarioId: 'circuits',
    messageType: 'resource', deepLinkReturnUrl: null, deepLinkData: null, ...overrides,
  };
  await pool.query(`
    INSERT INTO lti_sessions
      (id, issuer, client_id, deployment_id, sub, role, context_id, resource_link_id, lineitem_url,
       scenario_id, message_type, deep_link_return_url, deep_link_data, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + interval '1 hour')`,
  [crypto.createHash('sha256').update(token).digest('hex'), s.issuer, s.clientId, s.deploymentId, s.sub, s.role,
    s.contextId, s.resourceLinkId, s.lineitemUrl, s.scenarioId, s.messageType, s.deepLinkReturnUrl, s.deepLinkData]);
  return `lti_session=${token}`;
}

const teacherSession = (overrides = {}) => makeSession({
  role: 'instructor', messageType: 'deep-link', scenarioId: null, lineitemUrl: null, resourceLinkId: null,
  deepLinkReturnUrl: RETURN_URL, deepLinkData: 'opaque-data-1', ...overrides,
});

const submit = (cookie, body = {}) => request(app).post('/api/lti/submit').set('Cookie', cookie).send(body);
const pick = (cookie, body = { scenarioId: 'circuits' }) => request(app).post('/api/lti/deep-link').set('Cookie', cookie).send(body);
const sessionInfo = cookie => request(app).get('/api/lti/session').set('Cookie', cookie);

/** `{ error }` in Ukrainian and nothing else (plus `extra` keys when named). */
function assertError(res, status, extraKeys = []) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), ['error', ...extraKeys].sort());
  assert.match(res.body.error, UKRAINIAN);
}

const noAgsCalls = () => {
  const { ags } = platform;
  assert.equal(ags.tokenRequests.length + ags.resultRequests.length + ags.scores.length, 0, 'no call to the platform');
};

// ── Deep Linking (DW-5.1) ────────────────────────────

test('DW_5_1 deep-link answers an auto-submit page whose JWT is signed by the tool and describes one ltiResourceLink', async t => {
  if (skipUnlessDb(t)) return;

  const res = await pick(await teacherSession());

  assert.equal(res.status, 200, res.text);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.match(res.text, new RegExp(`<form method="post" action="${RETURN_URL}">`));
  const jwt = /name="JWT" value="([^"]+)"/.exec(res.text)[1];

  const { payload, protectedHeader } = await jwtVerify(jwt, toolJwks, { algorithms: ['RS256'] });
  assert.equal(protectedHeader.alg, 'RS256');
  assert.equal(payload.iss, CLIENT_ID);
  assert.equal(payload.aud, PLATFORM);
  assert.ok(payload.exp > payload.iat);
  assert.ok(payload.nonce);
  assert.equal(payload[`${CLAIM}message_type`], 'LtiDeepLinkingResponse');
  assert.equal(payload[`${CLAIM}version`], '1.3.0');
  assert.equal(payload[`${CLAIM}deployment_id`], DEPLOYMENT_ID);
  assert.equal(payload[`${DL}data`], 'opaque-data-1');

  const items = payload[`${DL}content_items`];
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'ltiResourceLink');
  assert.equal(items[0].title, 'Електричні кола');
  assert.equal(items[0].url, `${TOOL}/api/lti/launch`);
  assert.deepEqual(items[0].custom, { scenario_id: 'circuits' });
  assert.equal(items[0].lineItem.scoreMaximum, 100);
  assert.equal(items[0].lineItem.label, 'Електричні кола');
});

test('DW_5_1 deep-link page carries its own CSP: form-action only the platform, nonce-only script, platform-only framing', async t => {
  if (skipUnlessDb(t)) return;

  const res = await pick(await teacherSession());

  const csp = res.headers['content-security-policy'];
  assert.match(csp, /(^|; )form-action https:\/\/moodle\.test(;|$)/);
  assert.match(csp, /(^|; )frame-ancestors https:\/\/moodle\.test(;|$)/);
  assert.match(csp, /(^|; )default-src 'none'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
  assert.match(res.text, new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}">document\\.forms\\[0\\]\\.submit\\(\\);</script>`));
  assert.match(res.headers['cache-control'], /no-store/);
});

test('deep-link omits the data claim when the request carried none, and accepts a form body', async t => {
  if (skipUnlessDb(t)) return;

  const res = await request(app).post('/api/lti/deep-link')
    .set('Cookie', await teacherSession({ deepLinkData: null }))
    .type('form').send({ scenarioId: 'solar-system' });

  assert.equal(res.status, 200, res.text);
  const { payload } = await jwtVerify(/name="JWT" value="([^"]+)"/.exec(res.text)[1], toolJwks);
  assert.equal(`${DL}data` in payload, false);
  assert.deepEqual(payload[`${DL}content_items`][0].custom, { scenario_id: 'solar-system' });
});

test('deep-link escapes the return URL in the page', async t => {
  if (skipUnlessDb(t)) return;

  const res = await pick(await teacherSession({ deepLinkReturnUrl: `${PLATFORM}/return?a=1&b="2"` }));

  assert.equal(res.status, 200);
  assert.match(res.text, /action="https:\/\/moodle\.test\/return\?a=1&#38;b=%222%22"/);
});

test('deep-link edge: a session that is not an instructor deep-link launch is refused with 403', async t => {
  if (skipUnlessDb(t)) return;

  const sessions = {
    'learner resource launch': () => makeSession(),
    'instructor resource launch': () => makeSession({ role: 'instructor' }),
    'learner on a deep-link launch': () => teacherSession({ role: 'learner' }),
    'deep-link launch with no return URL': () => teacherSession({ deepLinkReturnUrl: null }),
  };
  for (const [name, create] of Object.entries(sessions)) {
    // beforeEach runs per subtest and truncates, so each subtest makes its own session
    await t.test(name, async () => assertError(await pick(await create()), 403));
  }
});

test('deep-link edge: unknown or unpublished scenario is 404 «Лабораторну знято»', async t => {
  if (skipUnlessDb(t)) return;
  const cookie = await teacherSession();

  for (const scenarioId of ['no-such-lab', 'hidden-lab']) {
    const res = await pick(cookie, { scenarioId });
    assertError(res, 404);
    assert.equal(res.body.error, 'Лабораторну знято');
  }
});

test('deep-link edge: missing, non-string or oversized scenarioId is 400', async t => {
  if (skipUnlessDb(t)) return;
  const cookie = await teacherSession();

  for (const body of [{}, { scenarioId: ['circuits'] }, { scenarioId: 'x'.repeat(101) }, { scenarioId: 7 }]) {
    assertError(await pick(cookie, body), 400);
  }
});

test('deep-link edge: a return URL off the platform host is refused', async t => {
  if (skipUnlessDb(t)) return;

  assertError(await pick(await teacherSession({ deepLinkReturnUrl: 'https://evil.test/return' })), 403);
});

test('deep-link and submit and session need a session: 401 without a cookie or with an unknown one', async t => {
  if (skipUnlessDb(t)) return;

  for (const res of [
    await request(app).post('/api/lti/deep-link').send({ scenarioId: 'circuits' }),
    await request(app).post('/api/lti/submit').send({}),
    await request(app).get('/api/lti/session'),
    await request(app).get('/api/lti/session').set('Cookie', 'lti_session=forged'),
  ]) {
    assertError(res, 401);
  }
});

test('state-changing endpoints refuse a foreign Origin or a non-same-origin fetch site (CSRF)', async t => {
  if (skipUnlessDb(t)) return;
  const learner = await makeSession();
  const teacher = await teacherSession();

  const headers = [{ Origin: 'https://evil.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }];
  for (const h of headers) {
    assertError(await request(app).post('/api/lti/submit').set('Cookie', learner).set(h).send({}), 403);
    assertError(await request(app).post('/api/lti/deep-link').set('Cookie', teacher).set(h).send({ scenarioId: 'circuits' }), 403);
  }
  noAgsCalls();

  // The tool's own origin passes.
  const ok = await request(app).post('/api/lti/submit').set('Cookie', learner)
    .set({ Origin: TOOL, 'Sec-Fetch-Site': 'same-origin' }).send({ score: 0.5 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// ── Session ──────────────────────────────────────────

test('session describes a learner on a graded scenario that is not yet submitted', async t => {
  if (skipUnlessDb(t)) return;

  const res = await sessionInfo(await makeSession());

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    scenarioId: 'circuits', role: 'learner', messageType: 'resource', graded: true, submitted: null,
  });
  const [read] = platform.ags.resultRequests;
  assert.equal(new URL(read.url).pathname, '/lineitem/7/results');
  assert.equal(new URL(read.url).searchParams.get('user_id'), 'user-1');
  assert.equal(read.init.headers.Accept, 'application/vnd.ims.lis.v2.resultcontainer+json');
});

test('session reports the grade Moodle already holds, as a fraction', async t => {
  if (skipUnlessDb(t)) return;
  platform.ags.results.body = [{ userId: 'user-1', resultScore: 80, resultMaximum: 100 }];

  const res = await sessionInfo(await makeSession());

  assert.deepEqual(res.body.submitted, { score: 0.8 });
});

test('session for a non-graded scenario says graded false', async t => {
  if (skipUnlessDb(t)) return;

  const res = await sessionInfo(await makeSession({ scenarioId: 'solar-system' }));

  assert.equal(res.body.graded, false);
});

test('session of a teacher on a deep-link launch asks Moodle nothing', async t => {
  if (skipUnlessDb(t)) return;

  const res = await sessionInfo(await teacherSession());

  assert.deepEqual(res.body, { scenarioId: null, role: 'instructor', messageType: 'deep-link', graded: false, submitted: null });
  noAgsCalls();
});

test('session without a line item, or for a withdrawn scenario, still answers and asks Moodle nothing', async t => {
  if (skipUnlessDb(t)) return;

  const noLineItem = await sessionInfo(await makeSession({ lineitemUrl: null }));
  assert.equal(noLineItem.status, 200);
  assert.equal(noLineItem.body.submitted, null);

  const gone = await sessionInfo(await makeSession({ scenarioId: 'deleted-lab', lineitemUrl: null }));
  assert.equal(gone.status, 200);
  assert.equal(gone.body.graded, false);
  noAgsCalls();
});

test('session degrades to submitted null when Moodle fails (submit stays the authority)', async t => {
  if (skipUnlessDb(t)) return;
  platform.ags.token = { status: 500, body: {} };

  const res = await sessionInfo(await makeSession());

  assert.equal(res.status, 200);
  assert.equal(res.body.submitted, null);
});

test('session of an instructor on a resource launch does not read a grade', async t => {
  if (skipUnlessDb(t)) return;

  const res = await sessionInfo(await makeSession({ role: 'instructor' }));

  assert.equal(res.body.role, 'instructor');
  assert.equal(res.body.submitted, null);
  noAgsCalls();
});

// ── Submit (DW-5.2) ──────────────────────────────────

test('DW_5_2 submit posts the AGS score payload to {lineitem}/scores and answers the score', async t => {
  if (skipUnlessDb(t)) return;

  const res = await submit(await makeSession(), { score: 0.756 });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { score: 0.756 });

  const [posted] = platform.ags.scores;
  assert.equal(new URL(posted.url).pathname, '/lineitem/7/scores');
  assert.equal(posted.init.method, 'POST');
  assert.equal(posted.init.headers['Content-Type'], 'application/vnd.ims.lis.v1.score+json');
  assert.equal(posted.init.headers.Authorization, 'Bearer ags-token-1');
  assert.deepEqual(Object.keys(posted.body).sort(),
    ['activityProgress', 'gradingProgress', 'scoreGiven', 'scoreMaximum', 'timestamp', 'userId']);
  assert.equal(posted.body.userId, 'user-1');
  assert.equal(posted.body.scoreGiven, 75.6);
  assert.equal(posted.body.scoreMaximum, 100);
  assert.equal(posted.body.activityProgress, 'Completed');
  assert.equal(posted.body.gradingProgress, 'FullyGraded');
  assert.ok(Math.abs(Date.parse(posted.body.timestamp) - Date.now()) < 60_000);
  assert.equal(new Date(posted.body.timestamp).toISOString(), posted.body.timestamp);
});

test('DW_5_2 submit gets its token with a signed client-credentials assertion for the registered scopes', async t => {
  if (skipUnlessDb(t)) return;

  await submit(await makeSession(), { score: 1 });

  const [{ form, init }] = platform.ags.tokenRequests;
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  assert.deepEqual(form.get('scope').split(' ').sort(), [
    'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem',
    'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly',
    'https://purl.imsglobal.org/spec/lti-ags/scope/score',
  ]);
  const { payload } = await jwtVerify(form.get('client_assertion'), toolJwks, { algorithms: ['RS256'] });
  assert.equal(payload.iss, CLIENT_ID);
  assert.equal(payload.sub, CLIENT_ID);
  assert.equal(payload.aud, `${PLATFORM}/token`);
  assert.ok(payload.jti);
});

test('DW_5_2 submit is refused with 409 and the existing score when the Result service reports a grade', async t => {
  if (skipUnlessDb(t)) return;
  platform.ags.results.body = [{ userId: 'user-1', resultScore: 40, resultMaximum: 100 }];

  const res = await submit(await makeSession(), { score: 1 });

  assertError(res, 409, ['score']);
  assert.equal(res.body.score, 0.4);
  assert.equal(platform.ags.scores.length, 0);
});

test('submit: a grade set in another scale or by anyone else still counts (409), a zero grade too', async t => {
  if (skipUnlessDb(t)) return;

  platform.ags.results.body = [{ userId: 'user-1', resultScore: 5, resultMaximum: 10 }];
  assert.equal((await submit(await makeSession())).body.score, 0.5);

  platform.ags.results.body = [{ userId: 'user-1', resultScore: 0, resultMaximum: 100 }];
  const zero = await submit(await makeSession());
  assert.equal(zero.status, 409);
  assert.equal(zero.body.score, 0);
  assert.equal(platform.ags.scores.length, 0);
});

test('submit ignores results that are not this learner\'s or carry no score', async t => {
  if (skipUnlessDb(t)) return;
  platform.ags.results.body = [
    { userId: 'someone-else', resultScore: 90, resultMaximum: 100 },
    { userId: 'user-1', resultMaximum: 100 },
    { userId: 'user-1', resultScore: null, resultMaximum: 100 },
    null,
  ];

  const res = await submit(await makeSession(), { score: 0.5 });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(platform.ags.scores.length, 1);
});

test('submit keeps the query string of the line item URL (Moodle puts type_id there)', async t => {
  if (skipUnlessDb(t)) return;

  const res = await submit(await makeSession({ lineitemUrl: `${LINEITEM}?type_id=1` }), { score: 0.5 });

  assert.equal(res.status, 200);
  const read = new URL(platform.ags.resultRequests[0].url);
  assert.equal(read.pathname, '/lineitem/7/results');
  assert.equal(read.searchParams.get('type_id'), '1');
  assert.equal(read.searchParams.get('user_id'), 'user-1');
  const post = new URL(platform.ags.scores[0].url);
  assert.equal(post.pathname, '/lineitem/7/scores');
  assert.equal(post.searchParams.get('type_id'), '1');
});

test('submit edge: score is rounded to two decimals of the 0..100 scale', async t => {
  if (skipUnlessDb(t)) return;

  await submit(await makeSession(), { score: 0.123456 });

  assert.equal(platform.ags.scores[0].body.scoreGiven, 12.35);
});

test('submit edge: a non-graded scenario sends 1.0 whatever the browser says', async t => {
  if (skipUnlessDb(t)) return;

  const res = await submit(await makeSession({ scenarioId: 'solar-system' }), { score: 0.2 });

  assert.deepEqual(res.body, { score: 1 });
  assert.equal(platform.ags.scores[0].body.scoreGiven, 100);
});

test('submit edge: a graded scenario with no score sends 0', async t => {
  if (skipUnlessDb(t)) return;

  for (const body of [{}, { score: null }]) {
    platform.ags.scores.length = 0;
    const res = await submit(await makeSession(), body);
    assert.deepEqual(res.body, { score: 0 });
    assert.equal(platform.ags.scores[0].body.scoreGiven, 0);
    platform.ags.results.body = [];
  }
});

test('submit edge: a score outside 0..1 is clamped', async t => {
  if (skipUnlessDb(t)) return;

  const high = await submit(await makeSession(), { score: 5 });
  assert.deepEqual(high.body, { score: 1 });
  assert.equal(platform.ags.scores[0].body.scoreGiven, 100);

  const low = await submit(await makeSession(), { score: -3 });
  assert.deepEqual(low.body, { score: 0 });
  assert.equal(platform.ags.scores[1].body.scoreGiven, 0);
});

test('submit edge: a graded score that is not a number is 400 and nothing reaches Moodle', async t => {
  if (skipUnlessDb(t)) return;

  for (const score of ['0.9', true, [1], { v: 1 }]) assertError(await submit(await makeSession(), { score }), 400);
  noAgsCalls();
});

test('submit edge: an instructor, or a deep-link session, is refused with 403 and Moodle is not called', async t => {
  if (skipUnlessDb(t)) return;

  assertError(await submit(await makeSession({ role: 'instructor' })), 403);
  assertError(await submit(await teacherSession()), 403);
  noAgsCalls();
});

test('submit edge: an unknown or unpublished scenario is 404 «Лабораторну знято»', async t => {
  if (skipUnlessDb(t)) return;

  for (const scenarioId of ['deleted-lab', 'hidden-lab']) {
    const res = await submit(await makeSession({ scenarioId }));
    assertError(res, 404);
    assert.equal(res.body.error, 'Лабораторну знято');
  }
  noAgsCalls();
});

test('submit edge: a launch without a line item is 409', async t => {
  if (skipUnlessDb(t)) return;

  assertError(await submit(await makeSession({ lineitemUrl: null })), 409);
  noAgsCalls();
});

test('submit edge: a failing token endpoint is 502 and nothing is claimed submitted', async t => {
  if (skipUnlessDb(t)) return;
  const cookie = await makeSession();

  for (const token of [
    { status: 500, body: {} },
    { status: 401, body: { error: 'invalid_client' } },
    { status: 200, body: { token_type: 'Bearer' } },
    { status: 200, body: 'not json' },
    { status: 200, body: { access_token: 42 }, },
    { status: 200, body: {}, throws: true },
  ]) {
    platform.ags.token = token;
    assertError(await submit(cookie, { score: 1 }), 502);
  }
  assert.equal(platform.ags.scores.length, 0);
  platform.ags.token = { status: 200, body: { access_token: 'ags-token-1' } };
  assert.equal((await submit(cookie, { score: 1 })).status, 200, 'a later retry may still succeed');
});

test('submit edge: a failing or malformed Results answer is 502 and nothing is posted', async t => {
  if (skipUnlessDb(t)) return;
  const cookie = await makeSession();

  for (const results of [
    { status: 500, body: {} },
    { status: 200, body: 'not json' },
    { status: 200, body: { not: 'a list' } },
    { status: 200, body: [{ userId: 'user-9', pad: 'x'.repeat(300 * 1024) }] },
  ]) {
    platform.ags.results = results;
    assertError(await submit(cookie), 502);
  }
  assert.equal(platform.ags.scores.length, 0);
});

test('submit edge: a failing score endpoint is 502', async t => {
  if (skipUnlessDb(t)) return;
  platform.ags.score = { status: 500, body: {} };

  assertError(await submit(await makeSession(), { score: 1 }), 502);
});

test('submit edge: a line item or token endpoint off the platform host is never called (SSRF)', async t => {
  if (skipUnlessDb(t)) return;

  for (const lineitemUrl of ['https://evil.test/lineitem/7', 'http://moodle.test/lineitem/7', 'https://moodle.test.evil.test/x']) {
    assertError(await submit(await makeSession({ lineitemUrl })), 502);
  }
  await pool.query(`UPDATE lti_registrations SET auth_token_url = 'https://evil.test/token'`);
  assertError(await submit(await makeSession()), 502);
  noAgsCalls();
});

test('submit needs application/json: a form post is 415 and Moodle is not called', async t => {
  if (skipUnlessDb(t)) return;
  const cookie = await makeSession();

  assertError(await request(app).post('/api/lti/submit').set('Cookie', cookie).type('form').send({ score: '1' }), 415);
  assertError(await request(app).post('/api/lti/submit').set('Cookie', cookie).type('text/plain').send('{"score":1}'), 415);
  assertError(await request(app).post('/api/lti/submit').set('Cookie', cookie), 415);
  noAgsCalls();
});

test('submit with a malformed JSON body is 400 in Ukrainian', async t => {
  if (skipUnlessDb(t)) return;

  const res = await request(app).post('/api/lti/submit').set('Cookie', await makeSession())
    .type('json').send('{"score": ');

  assertError(res, 400);
});

test('submit twice at once posts one score: the second is 409 without a score', async t => {
  if (skipUnlessDb(t)) return;
  platform.ags.results.delayMs = 150;
  const cookie = await makeSession();
  try {
    const [a, b] = await Promise.all([submit(cookie, { score: 1 }), submit(cookie, { score: 1 })]);

    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assertError(a.status === 409 ? a : b, 409);
    assert.equal(platform.ags.scores.length, 1);
  } finally {
    delete platform.ags.results.delayMs;
  }
});

test('submit: the in-flight guard is released after a failure, so a retry works', async t => {
  if (skipUnlessDb(t)) return;
  const cookie = await makeSession();
  platform.ags.score = { status: 500, body: {} };
  assertError(await submit(cookie, { score: 1 }), 502);

  platform.ags.score = { status: 200, body: {} };

  assert.equal((await submit(cookie, { score: 1 })).status, 200);
});

test('submit: a registration that vanished is 403', async t => {
  if (skipUnlessDb(t)) return;
  const cookie = await makeSession();
  await pool.query('DELETE FROM lti_registrations');

  assertError(await submit(cookie), 403);
  assertError(await pick(await teacherSession()), 403);
});
