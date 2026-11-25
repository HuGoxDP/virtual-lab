// backend/test/integration/lti-manual-registration-subpath.test.js
//
// P1e AC-4 against the REAL store (lti/store.js, real Postgres): a Moodle on a
// sub-path (issuer https://host/moodle) must land verbatim in lti_registrations
// and the exact (issuer, client_id) lookup must find it — the launch path reads
// the row by that exact string. Returns early per test when no database is
// reachable (each test returns early); pool.end() still runs in test.after.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../../server');
const { createStore } = require('../../lti/store');
const { main } = require('../../scripts/lti-add-registration');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');

const ISSUER = 'https://moodle.example.edu/moodle';

let available = false;

test.before(async () => {
  available = await isAvailable(pool);
  if (available) await prepareSchema(pool);
});

test.beforeEach(async () => {
  if (available) await truncateAll(pool);
});

test.after(async () => {
  if (available) await truncateAll(pool);
  await pool.end();
});

async function runScript(argv) {
  const lines = [];
  const errors = [];
  const code = await main(argv, {
    store: createStore(pool),
    out: { write: s => lines.push(s) },
    err: { write: s => errors.push(s) },
  });
  return { code, lines, errors };
}

test('P1e: a sub-path issuer is stored verbatim and getRegistration finds the row', async () => {
  if (!available) return;
  const { code } = await runScript([
    '--issuer', ISSUER, '--client-id', 'SubPathClient7', '--deployment-id', '3',
    '--auth-login-url', `${ISSUER}/mod/lti/auth.php`,
    '--auth-token-url', `${ISSUER}/mod/lti/token.php`,
    '--jwks-uri', `${ISSUER}/mod/lti/certs.php`,
  ]);
  assert.equal(code, 0);
  const store = createStore(pool);
  const saved = await store.getRegistration(ISSUER, 'SubPathClient7');
  assert.ok(saved, 'the exact (issuer, client_id) lookup must find the row');
  assert.equal(saved.issuer, ISSUER);
  assert.deepEqual(saved.deploymentIds, ['3']);
  assert.equal(await store.getRegistration('https://moodle.example.edu', 'SubPathClient7'), null,
    'the bare origin must not match: the launch matches the full Platform ID');
});

test('P1e: --from-moodle on a sub-path base stores issuer and endpoints under the path', async () => {
  if (!available) return;
  const { code } = await runScript([
    '--from-moodle', ISSUER, '--client-id', 'SubPathMoodle9', '--deployment-id', '4',
  ]);
  assert.equal(code, 0);
  const saved = await createStore(pool).getRegistration(ISSUER, 'SubPathMoodle9');
  assert.ok(saved);
  assert.equal(saved.authLoginUrl, `${ISSUER}/mod/lti/auth.php`);
  assert.equal(saved.authTokenUrl, `${ISSUER}/mod/lti/token.php`);
  assert.equal(saved.jwksUri, `${ISSUER}/mod/lti/certs.php`);
});
