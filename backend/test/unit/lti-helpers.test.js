// backend/test/unit/lti-helpers.test.js
//
// Phase 4 (LTI): the pure parts of the LTI module: config, http helpers, claim parsing, the registration
// request / configuration check, the session middleware and the key store. No database.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLocalJWKSet, jwtVerify } = require('jose');

const { readConfig } = require('../../lti/config');
const http = require('../../lti/http');
const { roleFrom, scenarioIdFrom, parseLaunchClaims, CLAIMS } = require('../../lti/launch');
const { checkConfiguration, buildRegistrationRequest, NS_TOOL } = require('../../lti/registration');
const { createRequireLtiSession } = require('../../lti/session');
const { createKeyStore } = require('../../lti/keys');
const lti = require('../../lti');

const REGISTRATION = { issuer: 'https://m.test', clientId: 'c1', deploymentIds: ['d1'] };
const STATE = { targetLinkUri: 'https://tool.test/api/lti/launch' };

// ── config ───────────────────────────────────────────

test('readConfig: https public URL is normalised to its origin, anything else is null', () => {
  assert.equal(readConfig({ LTI_PUBLIC_URL: 'https://lab.example.edu/some/path/' }).publicUrl, 'https://lab.example.edu');
  assert.equal(readConfig({ LTI_PUBLIC_URL: 'http://lab.example.edu' }).publicUrl, null);
  assert.equal(readConfig({ LTI_PUBLIC_URL: 'nonsense' }).publicUrl, null);
  assert.equal(readConfig({}).publicUrl, null);
});

test('readConfig: numeric settings fall back on junk, secret is null when empty', () => {
  const defaults = readConfig({});
  assert.equal(defaults.sessionTtlSeconds, 4 * 3600);
  assert.equal(defaults.rateLimit, 600);
  assert.equal(defaults.registrationSecret, null);
  assert.equal(defaults.stateTtlSeconds, 600);
  assert.ok(defaults.toolName);

  const custom = readConfig({ LTI_SESSION_TTL_SECONDS: '60', LTI_RATE_LIMIT: '5', LTI_REGISTRATION_SECRET: 's', LTI_TOOL_NAME: 'N' });
  assert.deepEqual([custom.sessionTtlSeconds, custom.rateLimit, custom.registrationSecret, custom.toolName], [60, 5, 's', 'N']);

  for (const junk of ['abc', '-5', '0', '1.5', '']) {
    assert.equal(readConfig({ LTI_SESSION_TTL_SECONDS: junk }).sessionTtlSeconds, 4 * 3600, junk);
  }
});

// ── http helpers ─────────────────────────────────────

test('LtiError keeps status, message and a separate log detail', () => {
  const e = new http.LtiError(403, 'Повідомлення', 'detail');
  assert.deepEqual([e.status, e.message, e.detail], [403, 'Повідомлення', 'detail']);
  assert.equal(new http.LtiError(400, 'Тільки').detail, 'Тільки');
});

test('randomToken is URL-safe and unique; sha256Hex is stable', () => {
  const a = http.randomToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, http.randomToken());
  assert.equal(http.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('safeEqual compares exactly and tolerates different lengths', () => {
  assert.equal(http.safeEqual('abc', 'abc'), true);
  assert.equal(http.safeEqual('abc', 'abd'), false);
  assert.equal(http.safeEqual('abc', 'abcd'), false);
  assert.equal(http.safeEqual('', ''), true);
});

test('parseCookies handles several cookies, values with "=", junk and no header', () => {
  assert.deepEqual(http.parseCookies('a=1; b=x=y;  c = 3 ; =bad; novalue'), { a: '1', b: 'x=y', c: '3' });
  assert.deepEqual(http.parseCookies(undefined), {});
  assert.deepEqual(http.parseCookies(''), {});
});

test('serializeCookie always sets HttpOnly, Secure, SameSite=None and Partitioned', () => {
  const cookie = http.serializeCookie('n', 'v', { maxAgeSeconds: 0, path: '/api/lti' });
  assert.equal(cookie, 'n=v; Path=/api/lti; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned');
  assert.match(http.serializeCookie('n', 'v', { maxAgeSeconds: 5 }), /^n=v; Path=\/; Max-Age=5; /);
});

test('str only passes bounded strings; parseHttpsUrl only plain https', () => {
  assert.equal(http.str('x'), 'x');
  assert.equal(http.str(['x']), '');
  assert.equal(http.str({}), '');
  assert.equal(http.str(5), '');
  assert.equal(http.str('x'.repeat(5000)), '');
  assert.equal(http.str('x'.repeat(5000), 6000).length, 5000);

  assert.equal(http.parseHttpsUrl('https://a.test/p?q=1').host, 'a.test');
  for (const bad of ['http://a.test', 'https://u:p@a.test', 'https://:p@a.test', 'ftp://a.test', 'x', '', undefined]) {
    assert.equal(http.parseHttpsUrl(bad), null, String(bad));
  }
});

// ── claims ───────────────────────────────────────────

test('roleFrom: instructor and administrator URIs, everything else is learner', () => {
  assert.equal(roleFrom(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor']), 'instructor');
  assert.equal(roleFrom(['http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator']), 'instructor');
  assert.equal(roleFrom(['http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor']), 'instructor');
  assert.equal(roleFrom(['http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator']), 'instructor');
  assert.equal(roleFrom(['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner']), 'learner');
  assert.equal(roleFrom(['http://purl.imsglobal.org/vocab/lis/v2/membership#Mentor']), 'learner');
  assert.equal(roleFrom([]), 'learner');
  assert.equal(roleFrom('Instructor'), 'learner');
  assert.equal(roleFrom(undefined), 'learner');
});

test('scenarioIdFrom: custom claim wins, then ?scenario_id, then /play/<id>; unsafe ids are refused', () => {
  const T = 'https://tool.test';
  assert.equal(scenarioIdFrom({ scenario_id: 'circuits' }, `${T}/play/other`), 'circuits');
  assert.equal(scenarioIdFrom({}, `${T}/api/lti/launch?scenario_id=solar-system`), 'solar-system');
  assert.equal(scenarioIdFrom(undefined, `${T}/play/solar-system`), 'solar-system');
  assert.equal(scenarioIdFrom(undefined, `${T}/play/solar-system/`), 'solar-system');
  assert.equal(scenarioIdFrom(undefined, `${T}/play/a.b_c-1`), 'a.b_c-1');
  assert.equal(scenarioIdFrom(undefined, `${T}/api/lti/launch`), null);
  assert.equal(scenarioIdFrom({ scenario_id: '../x' }, `${T}/play/ok`), null, 'a bad custom id does not fall through');
  assert.equal(scenarioIdFrom(undefined, `${T}/play/..%2Fx`), null);
  assert.equal(scenarioIdFrom(undefined, `${T}/play/%E0%A4%A`), null, 'malformed percent-encoding');
  assert.equal(scenarioIdFrom(undefined, `${T}/play/${'a'.repeat(101)}`), null);
  assert.equal(scenarioIdFrom(undefined, 'not a url'), null);
  assert.equal(scenarioIdFrom({ scenario_id: 'x'.repeat(101) }, `${T}/play/ok`), 'ok', 'too long to be read: ignored');
});

test('parseLaunchClaims: extracts the session fields of a resource launch', () => {
  const session = parseLaunchClaims({
    sub: 's1',
    [CLAIMS.messageType]: 'LtiResourceLinkRequest',
    [CLAIMS.version]: '1.3.0',
    [CLAIMS.deploymentId]: 'd1',
    [CLAIMS.targetLinkUri]: STATE.targetLinkUri,
    [CLAIMS.resourceLink]: { id: 'rl' },
    [CLAIMS.roles]: [],
    [CLAIMS.custom]: { scenario_id: 'circuits' },
    [CLAIMS.agsEndpoint]: { lineitem: 'http://insecure.test/li' },
  }, REGISTRATION, STATE);

  assert.equal(session.scenarioId, 'circuits');
  assert.equal(session.contextId, null);
  assert.equal(session.lineitemUrl, null, 'a non-https line item is not trusted');
  assert.equal(session.messageType, 'resource');
  assert.equal(session.role, 'learner');
});

// ── registration helpers ─────────────────────────────

const GOOD_CONFIG = {
  issuer: 'https://m.test',
  authorization_endpoint: 'https://m.test/auth',
  token_endpoint: 'https://m.test/token',
  jwks_uri: 'https://m.test/jwks',
  registration_endpoint: 'https://m.test/reg',
};

test('checkConfiguration returns the stored fields for a sound configuration', () => {
  assert.deepEqual(checkConfiguration(GOOD_CONFIG, new URL('https://m.test/.well-known/x')), {
    issuer: 'https://m.test',
    authLoginUrl: 'https://m.test/auth',
    authTokenUrl: 'https://m.test/token',
    jwksUri: 'https://m.test/jwks',
    registrationEndpoint: 'https://m.test/reg',
    issuerOrigin: 'https://m.test',
  });
});

test('checkConfiguration refuses non-objects and foreign hosts or ports', () => {
  for (const bad of [null, undefined, 'x', 5]) {
    assert.throws(() => checkConfiguration(bad, new URL('https://m.test/c')), { status: 400 });
  }
  assert.throws(() => checkConfiguration(GOOD_CONFIG, new URL('https://other.test/c')), { status: 400 });
  assert.throws(() => checkConfiguration(
    { ...GOOD_CONFIG, registration_endpoint: 'https://m.test:8443/reg' }, new URL('https://m.test/c')), { status: 400 });
});

test('checkConfiguration refuses every endpoint on a foreign host', () => {
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'registration_endpoint']) {
    assert.throws(() => checkConfiguration({ ...GOOD_CONFIG, [key]: 'https://evil.test/x' }, new URL('https://m.test/c')),
      { status: 400 }, key);
  }
});

test('createRemoteKeyResolverCache: one resolver per JWKS URI, reused on the same URI', () => {
  const resolverFor = lti.createRemoteKeyResolverCache();

  const a = resolverFor('https://a.test/jwks');
  assert.equal(typeof a, 'function');
  assert.equal(resolverFor('https://a.test/jwks'), a);
  assert.notEqual(resolverFor('https://b.test/jwks'), a);
  assert.equal(lti.createRemoteKeyResolverCache()('https://a.test/jwks') === a, false, 'caches are not shared between routers');
});

test('buildRegistrationRequest asks for no personal claims and declares the tool domain', () => {
  const body = buildRegistrationRequest('https://lab.example.edu', 'Лабораторія');
  assert.deepEqual(body[NS_TOOL].claims, ['iss', 'sub']);
  assert.equal(body[NS_TOOL].domain, 'lab.example.edu');
  assert.equal(body.client_name, 'Лабораторія');
  assert.equal(body.jwks_uri, 'https://lab.example.edu/api/lti/jwks');
});

// ── session middleware ───────────────────────────────

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
const fakeReq = cookie => ({ get: name => (name === 'cookie' ? cookie : undefined) });

test('requireLtiSession: valid cookie sets req.lti and calls next; the lookup key is the hash', async () => {
  let looked;
  const middleware = createRequireLtiSession({ findSession: async id => { looked = id; return { id, sub: 's' }; } });
  const req = fakeReq('lti_session=tok');
  let nexted = false;

  await middleware(req, fakeRes(), () => { nexted = true; });

  assert.equal(nexted, true);
  assert.equal(looked, http.sha256Hex('tok'));
  assert.equal(req.lti.sub, 's');
});

test('requireLtiSession: no cookie or unknown session is 401 {error}; a store failure is 500 {error}', async t => {
  t.mock.method(console, 'error', () => {});

  const none = fakeRes();
  await createRequireLtiSession({ findSession: async () => null })(fakeReq(undefined), none, () => assert.fail('next'));
  assert.equal(none.statusCode, 401);
  assert.deepEqual(Object.keys(none.body), ['error']);

  const unknown = fakeRes();
  await createRequireLtiSession({ findSession: async () => null })(fakeReq('lti_session=x'), unknown, () => assert.fail('next'));
  assert.equal(unknown.statusCode, 401);

  const broken = fakeRes();
  await createRequireLtiSession({ findSession: async () => { throw new Error('db down'); } })(
    fakeReq('lti_session=x'), broken, () => assert.fail('next'));
  assert.equal(broken.statusCode, 500);
  assert.deepEqual(broken.body, { error: 'Помилка сервера' });
});

// ── the Produces surface before a router exists ──────

test('the context-bound exports fail loudly (or answer 503) before createLtiRouter ran', () => {
  assert.throws(() => lti.getRegistration('i', 'c'), /before createLtiRouter/);
  assert.throws(() => lti.signToolJwt({}), /before createLtiRouter/);
  const res = fakeRes();
  lti.requireLtiSession(fakeReq(undefined), res, () => assert.fail('next'));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(Object.keys(res.body), ['error']);
});

// ── key store ────────────────────────────────────────

const pkcs8 = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const pkcs1 = () => crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });

async function assertSignsAndPublishes(store) {
  const jwks = await store.getJwks();
  const token = await store.sign({ iss: 'tool' });
  const { protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks));
  assert.equal(protectedHeader.kid, jwks.keys[0].kid);
  assert.equal(protectedHeader.kid, await store.kid());
}

test('key store: a PEM from the environment, PKCS#8 or PKCS#1, with real or escaped newlines', async t => {
  t.mock.method(console, 'log', () => {});

  const escaped = pkcs8().trim().replace(/\n/g, '\\n');
  assert.equal(escaped.includes('\n'), false, 'the fixture really is single-line');

  await assertSignsAndPublishes(createKeyStore({ LTI_TOOL_PRIVATE_KEY: pkcs8() }));
  await assertSignsAndPublishes(createKeyStore({ LTI_TOOL_PRIVATE_KEY: pkcs1() }));
  await assertSignsAndPublishes(createKeyStore({ LTI_TOOL_PRIVATE_KEY: escaped }));
});

test('key store: a key file is created on first start (mode 0600) and reused after', async t => {
  t.mock.method(console, 'log', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lti-keys-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'tool-key.pem');

  const first = createKeyStore({ LTI_TOOL_KEY_FILE: file });
  const kid1 = await first.kid();
  assert.match(await fs.readFile(file, 'utf8'), /BEGIN PRIVATE KEY/);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  const second = createKeyStore({ LTI_TOOL_KEY_FILE: file });
  assert.equal(await second.kid(), kid1, 'the same file gives the same key');
  await assertSignsAndPublishes(second);
});

test('key store: an unreadable or junk key file is an error, not a silent new key', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lti-keys-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await assert.rejects(createKeyStore({ LTI_TOOL_KEY_FILE: dir }).kid());
  await fs.writeFile(path.join(dir, 'junk.pem'), 'not a key');
  await assert.rejects(createKeyStore({ LTI_TOOL_KEY_FILE: path.join(dir, 'junk.pem') }).kid());
});

test('key store: without any source it falls back to an ephemeral key and says so', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});

  await assertSignsAndPublishes(createKeyStore({}));

  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /ephemeral/);
});

test('key store: sign() keeps iat/exp the caller set and adds them otherwise', async t => {
  t.mock.method(console, 'log', () => {});
  const store = createKeyStore({ LTI_TOOL_PRIVATE_KEY: pkcs8() });

  const given = await store.sign({ iss: 'x', iat: 1000, exp: 2000 });
  const { payload } = await jwtVerify(given, createLocalJWKSet(await store.getJwks()), { currentDate: new Date(1500 * 1000) });
  assert.deepEqual([payload.iat, payload.exp], [1000, 2000]);

  const added = JSON.parse(Buffer.from((await store.sign({ iss: 'x' })).split('.')[1], 'base64url'));
  assert.equal(added.exp - added.iat, 300);
});

test('key store: a failed load is not cached, a repaired file works without a restart', async t => {
  t.mock.method(console, 'log', () => {});
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lti-keys-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'k.pem');
  await fs.writeFile(file, 'junk');
  const flaky = createKeyStore({ LTI_TOOL_KEY_FILE: file });

  await assert.rejects(flaky.kid());
  await fs.writeFile(file, pkcs8());

  assert.ok(await flaky.kid());
});
