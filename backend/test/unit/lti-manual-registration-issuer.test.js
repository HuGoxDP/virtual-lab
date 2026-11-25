// backend/test/unit/lti-manual-registration-issuer.test.js
//
// P1c review r1 / P1e AC-4: the stored issuer must be the string the admin gave, VERBATIM.
// Dynamic Registration (lti/registration.js:80) stores `str(config.issuer)` untouched and the
// store's lookups are exact string matches (lti/store.js `WHERE issuer = $1`), so reducing a
// sub-path Moodle (https://host/moodle) to its origin made every launch 403 — the row could
// never be found. These tests pin verbatim storage end-to-end (normaliseRegistration →
// registrationFromArgs → main with a fake store whose getRegistration compares exactly, like
// store.js), plus the unchanged validation: https, no credentials, endpoints on the issuer
// origin. Own constants on purpose: no imports of the P1c test's fixtures.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseRegistration } = require('../../lti/manual-registration');
const { registrationFromArgs, parseArgs, main } = require('../../scripts/lti-add-registration');

const BASE = 'https://h.example';
const SUB = `${BASE}/moodle`;
const ENDPOINTS = base => ({
  authLoginUrl: `${base}/mod/lti/auth.php`,
  authTokenUrl: `${base}/mod/lti/token.php`,
  jwksUri: `${base}/mod/lti/certs.php`,
});

/** A store whose lookups compare issuer by exact string equality, like lti/store.js. */
function exactStore() {
  const rows = [];
  return {
    rows,
    async saveRegistration(row) { rows.push(row); },
    async getRegistration(issuer, clientId) {
      return rows.find(r => r.issuer === issuer && r.clientId === clientId) || null;
    },
  };
}

/** Runs main with writable-stream IO ({write}), the spec's interface. */
async function runMain(argv, store) {
  const lines = [];
  const errors = [];
  const code = await main(argv, {
    store,
    out: { write: s => lines.push(s) },
    err: { write: s => errors.push(s) },
  });
  return { code, lines, errors };
}

const CLI_ENDPOINTS = base => [
  '--auth-login-url', `${base}/mod/lti/auth.php`,
  '--auth-token-url', `${base}/mod/lti/token.php`,
  '--jwks-uri', `${base}/mod/lti/certs.php`,
];

// (a) sub-path issuer preserved verbatim end-to-end; exact lookup finds the row.
test('P1e: a sub-path issuer survives main() verbatim and the exact lookup finds it', async () => {
  const store = exactStore();
  const { code } = await runMain([
    '--issuer', SUB, '--client-id', 'c', '--deployment-id', '1', ...CLI_ENDPOINTS(SUB),
  ], store);
  assert.equal(code, 0);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].issuer, SUB, 'issuer must be the given string, not its origin');
  assert.ok(await store.getRegistration(SUB, 'c'), 'exact (issuer, client_id) lookup must find the row');
  assert.equal(await store.getRegistration(BASE, 'c'), null, 'the origin must NOT find it');
});

// (b) --from-moodle on a sub-path base: issuer and endpoints under the base.
test('P1e: --from-moodle with a sub-path base keeps the path in issuer and endpoints', async () => {
  const store = exactStore();
  const { code } = await runMain([
    '--from-moodle', SUB, '--client-id', 'c', '--deployment-id', '1',
  ], store);
  assert.equal(code, 0);
  assert.equal(store.rows[0].issuer, SUB);
  assert.equal(store.rows[0].authLoginUrl, `${SUB}/mod/lti/auth.php`);
  assert.equal(store.rows[0].authTokenUrl, `${SUB}/mod/lti/token.php`);
  assert.equal(store.rows[0].jwksUri, `${SUB}/mod/lti/certs.php`);
  assert.ok(await store.getRegistration(SUB, 'c'));
});

// (c) verbatim, DR parity: a trailing slash given as --issuer is KEPT.
test('P1e: --issuer with a trailing slash stores the slash; a lookup without it does not match', async () => {
  const store = exactStore();
  const { code } = await runMain([
    '--issuer', `${SUB}/`, '--client-id', 'c', '--deployment-id', '1', ...CLI_ENDPOINTS(SUB),
  ], store);
  assert.equal(code, 0);
  assert.equal(store.rows[0].issuer, `${SUB}/`, 'no slash may be added or removed (registration.js parity)');
  assert.equal(await store.getRegistration(SUB, 'c'), null);
  assert.ok(await store.getRegistration(`${SUB}/`, 'c'));
});

// (d) a bare origin stays bare: no trailing slash is added.
test('P1e: normaliseRegistration keeps a bare issuer without adding a slash', () => {
  const row = normaliseRegistration({
    issuer: BASE, clientId: 'c', deploymentIds: ['1'], ...ENDPOINTS(BASE),
  });
  assert.equal(row.issuer, BASE);
});

// (e) --from-moodle strips trailing slashes from the base.
test('P1e: --from-moodle with a trailing slash yields the base without it', () => {
  const row = registrationFromArgs(parseArgs([
    '--from-moodle', `${SUB}/`, '--client-id', 'c', '--deployment-id', '1',
  ]));
  assert.equal(row.issuer, SUB);
});

// (f) validation unchanged: foreign-host endpoint and http issuer refused, nothing saved.
test('P1e: a foreign-host endpoint with a sub-path issuer exits 2 and saves nothing', async () => {
  const store = exactStore();
  const { code, errors } = await runMain([
    '--issuer', SUB, '--client-id', 'c', '--deployment-id', '1',
    '--auth-login-url', 'https://evil.example/mod/lti/auth.php',
    '--auth-token-url', `${SUB}/mod/lti/token.php`,
    '--jwks-uri', `${SUB}/mod/lti/certs.php`,
  ], store);
  assert.equal(code, 2);
  assert.equal(store.rows.length, 0);
  assert.match(errors.join(''), /auth_login_url/);
});

test('P1e: an http:// issuer exits 2 and saves nothing', async () => {
  const store = exactStore();
  const { code, errors } = await runMain([
    '--issuer', 'http://h.example/moodle', '--client-id', 'c', '--deployment-id', '1',
    ...CLI_ENDPOINTS(SUB),
  ], store);
  assert.equal(code, 2);
  assert.equal(store.rows.length, 0);
  assert.match(errors.join(''), /issuer/);
});

// (g) dry run saves nothing, prints the verbatim row.
test('P1e: --dry-run with a sub-path issuer prints it verbatim and saves nothing', async () => {
  const store = exactStore();
  const { code, lines } = await runMain([
    '--issuer', SUB, '--client-id', 'c', '--deployment-id', '1', ...CLI_ENDPOINTS(SUB), '--dry-run',
  ], store);
  assert.equal(code, 0);
  assert.equal(store.rows.length, 0);
  assert.equal(JSON.parse(lines[0]).registration.issuer, SUB);
});

// Endpoints on the same origin OUTSIDE the sub-path are accepted (origin check, not path check).
test('P1e: endpoints on the issuer origin outside the sub-path are accepted', () => {
  const row = normaliseRegistration({
    issuer: SUB, clientId: 'c', deploymentIds: ['1'], ...ENDPOINTS(BASE),
  });
  assert.equal(row.issuer, SUB);
  assert.equal(row.authLoginUrl, `${BASE}/mod/lti/auth.php`);
});

// Non-blocking (c): deployment ids are bounded like launch.js reads them (str(payload, 255)).
test('P1c r1: deployment ids longer than 255 chars are refused (launch.js would never match them)', () => {
  const long = '9'.repeat(256);
  assert.throws(
    () => normaliseRegistration({ issuer: BASE, clientId: 'c', deploymentIds: [long], ...ENDPOINTS(BASE) }),
    /deployment_id.*255/,
  );
  const row = normaliseRegistration({
    issuer: BASE, clientId: 'c', deploymentIds: ['9'.repeat(255)], ...ENDPOINTS(BASE),
  });
  assert.deepEqual(row.deploymentIds, ['9'.repeat(255)]);
});
