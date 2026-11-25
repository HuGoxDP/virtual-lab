// backend/test/integration/lti-manual-registration.test.js
//
// P1c: the manual-registration script against the REAL store (`lti/store.js`, real Postgres) —
// the stub-store unit test pins the rules and the wiring, this pins that what the script writes is
// what `launch.js` reads back: the row lands in `lti_registrations`, keyed by (issuer, client_id),
// with the deployment list the launch must match, and a re-run refreshes it in place (so an admin
// who fixed a typo does not end up with two rows).
//
// Returns early per test when no database is reachable, like every integration test here.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('../../server');
const { createStore } = require('../../lti/store');
const { normaliseRegistration } = require('../../lti/manual-registration');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const { main } = require('../../scripts/lti-add-registration');

const ISSUER = 'https://moodle.example.edu';
const REGISTRATION = {
  issuer: ISSUER,
  clientId: 'ManualClientId42',
  deploymentIds: ['1', '2'],
  authLoginUrl: `${ISSUER}/mod/lti/auth.php`,
  authTokenUrl: `${ISSUER}/mod/lti/token.php`,
  jwksUri: `${ISSUER}/mod/lti/certs.php`,
};

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

/** Early-return guard: keeps the test count honest when no database is reachable. */
function dbReady() {
  return available;
}

/** The script's real path: validated row in, `createStore(pool)` writes it. */
async function runScript(argv) {
  const lines = [];
  const errors = [];
  const code = await main(argv, { store: createStore(pool), out: { write: s => lines.push(s) }, err: { write: s => errors.push(s) } });
  return { code, lines, errors };
}

test('P1c: the script writes the row launch.js reads — issuer, client_id, deployment list, endpoints', async () => {
  if (!dbReady()) return;
  const { code } = await runScript([
    '--from-moodle', ISSUER, '--client-id', REGISTRATION.clientId, '--deployment-id', '1,2',
  ]);
  assert.equal(code, 0);

  const store = createStore(pool);
  const saved = await store.getRegistration(ISSUER, REGISTRATION.clientId);
  assert.ok(saved, 'the row must exist under (issuer, client_id)');
  assert.deepEqual(saved.deploymentIds, REGISTRATION.deploymentIds);
  assert.equal(saved.authLoginUrl, REGISTRATION.authLoginUrl);
  assert.equal(saved.authTokenUrl, REGISTRATION.authTokenUrl);
  assert.equal(saved.jwksUri, REGISTRATION.jwksUri);

  const listed = await store.listRegistrations(ISSUER);
  assert.equal(listed.length, 1, 'one row per issuer/client — listRegistrations is what the login path reads');
});

test('P1c: a re-run refreshes the same row instead of adding a second', async () => {
  if (!dbReady()) return;
  await runScript(['--from-moodle', ISSUER, '--client-id', REGISTRATION.clientId, '--deployment-id', '1']);
  await runScript(['--from-moodle', ISSUER, '--client-id', REGISTRATION.clientId, '--deployment-id', '1,9']);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM lti_registrations WHERE issuer = $1', [ISSUER]);
  assert.equal(rows[0].n, 1, 'the upsert must keep one row');
  const saved = await createStore(pool).getRegistration(ISSUER, REGISTRATION.clientId);
  assert.deepEqual(saved.deploymentIds, ['1', '9'], 'the corrected deployment list must win');
});

test('P1c: --dry-run writes nothing even with a real store', async () => {
  if (!dbReady()) return;
  const { code } = await runScript([
    '--from-moodle', ISSUER, '--client-id', 'DryRunOnly', '--deployment-id', '1', '--dry-run',
  ]);
  assert.equal(code, 0);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM lti_registrations');
  assert.equal(rows[0].n, 0, 'a dry run must leave the table empty');
});

test('P1c: the validated row is exactly the shape store.saveRegistration takes', async () => {
  if (!dbReady()) return;
  // Written through the store directly (no script): proves the module and the store agree, so a
  // future column rename breaks this test rather than a live registration.
  await createStore(pool).saveRegistration(normaliseRegistration(REGISTRATION));
  const saved = await createStore(pool).getRegistration(ISSUER, REGISTRATION.clientId);
  assert.deepEqual(saved, REGISTRATION);
});