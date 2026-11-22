// backend/test/unit/lti-manual-registration.test.js
//
// P1c: the tool-side half of a manual platform registration. Dynamic Registration is the only
// path that writes `lti_registrations` on its own, so an admin whose Moodle blocks it got 403
// «Платформа не зареєстрована» on every launch after filling Moodle's form. The fix is
// `scripts/lti-add-registration.js`; its rules and its wiring are pinned here, with a stub store
// instead of a database (the real write is one `INSERT … ON CONFLICT`, exercised by the
// integration suite's `saveRegistration` tests).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseRegistration, normaliseDeployments, MOODLE_ENDPOINTS } =
  require('../../lti/manual-registration');
const { parseArgs, registrationFromArgs, fromMoodle, main } =
  require('../../scripts/lti-add-registration');

const ISSUER = 'https://moodle.example.edu';
const VALID = {
  issuer: ISSUER,
  clientId: 'AbC123clientid',
  deploymentIds: ['1'],
  authLoginUrl: `${ISSUER}/mod/lti/auth.php`,
  authTokenUrl: `${ISSUER}/mod/lti/token.php`,
  jwksUri: `${ISSUER}/mod/lti/certs.php`,
};

/** A store that records what the script would write. */
function stubStore() {
  const written = [];
  return {
    written,
    async saveRegistration(row) { written.push(row); },
    async getRegistration(issuer, clientId) {
      return written.find(r => r.issuer === issuer && r.clientId === clientId) || null;
    },
  };
}

/** Runs `main` with captured output. */
async function run(argv, store) {
  const lines = [];
  const errors = [];
  const code = await main(argv, {
    store: store || stubStore(),
    out: line => lines.push(line),
    err: line => errors.push(line),
  });
  return { code, lines, errors };
}

// ── rules ────────────────────────────────────────────

test('P1c: a complete registration is accepted and the issuer is normalised to its origin', () => {
  const row = normaliseRegistration({ ...VALID, issuer: `${ISSUER}/some/path` });
  assert.deepEqual(row, VALID);
});

test('P1c: every URL must be https and carry no credentials', () => {
  const cases = [
    ['issuer', 'http://moodle.example.edu'],
    ['authLoginUrl', 'http://moodle.example.edu/mod/lti/auth.php'],
    ['authTokenUrl', 'https://user:pw@moodle.example.edu/mod/lti/token.php'],
    ['jwksUri', 'mod/lti/certs.php'],
  ];
  for (const [field, value] of cases) {
    assert.throws(() => normaliseRegistration({ ...VALID, [field]: value }), Error, `${field}=${value}`);
  }
});

test('P1c: the three endpoints must live on the issuer origin (grades.js refuses anything else at grade time)', () => {
  for (const field of ['authLoginUrl', 'authTokenUrl', 'jwksUri']) {
    assert.throws(
      () => normaliseRegistration({ ...VALID, [field]: `https://evil.example/mod/lti/x.php` }),
      /тому самому хості/,
      field,
    );
  }
});

test('P1c: client_id is required and bounded; at least one deployment id is required', () => {
  assert.throws(() => normaliseRegistration({ ...VALID, clientId: '' }), /client_id/);
  assert.throws(() => normaliseRegistration({ ...VALID, clientId: 'x'.repeat(256) }), /255/);
  assert.throws(() => normaliseRegistration({ ...VALID, deploymentIds: [] }), /deployment_id/);
  assert.throws(() => normaliseRegistration({ ...VALID, deploymentIds: ' ,  ' }), /deployment_id/);
});

test('P1c: deployment ids accept a comma/space list, trim and de-duplicate it', () => {
  assert.deepEqual(normaliseDeployments('1, 2  3,,1'), ['1', '2', '3']);
  assert.deepEqual(normaliseDeployments([' a ', 'a', 'b']), ['a', 'b']);
  assert.deepEqual(normaliseDeployments(undefined), []);
});

// ── flag parsing and wiring ──────────────────────────

test('P1c: --from-moodle fills the three Moodle endpoints and defaults the issuer to that origin', () => {
  assert.deepEqual(fromMoodle(`${ISSUER}/`), {
    authLoginUrl: `${ISSUER}${MOODLE_ENDPOINTS.authLoginUrl}`,
    authTokenUrl: `${ISSUER}${MOODLE_ENDPOINTS.authTokenUrl}`,
    jwksUri: `${ISSUER}${MOODLE_ENDPOINTS.jwksUri}`,
  });
  assert.deepEqual(MOODLE_ENDPOINTS, {
    authLoginUrl: '/mod/lti/auth.php',
    authTokenUrl: '/mod/lti/token.php',
    jwksUri: '/mod/lti/certs.php',
  });
  const row = registrationFromArgs(parseArgs([
    '--from-moodle', ISSUER, '--client-id', 'c1', '--deployment-id', '7',
  ]));
  assert.equal(row.issuer, ISSUER);
  assert.equal(row.clientId, 'c1');
  assert.deepEqual(row.deploymentIds, ['7']);
  assert.equal(row.authLoginUrl, `${ISSUER}/mod/lti/auth.php`);
});

test('P1c: --flag=value, --issuer override, and unknown or valueless flags are refused', () => {
  const args = parseArgs(['--from-moodle=https://m.test', '--issuer=https://public.example', '--client-id=c1', '--deployment-id=1', '--dry-run']);
  assert.deepEqual(
    [args.fromMoodle, args.issuer, args.clientId, args.deploymentIds, args.dryRun],
    ['https://m.test', 'https://public.example', 'c1', '1', true],
  );
  assert.throws(() => parseArgs(['--nope', 'x']), /unknown flag/);
  assert.throws(() => parseArgs(['--client-id']), /needs a value/);
});

test('P1c: --dry-run validates, prints the row and writes nothing', async () => {
  const store = stubStore();
  const { code, lines } = await run([
    '--issuer', ISSUER, '--client-id', 'c1', '--deployment-id', '1,2',
    '--auth-login-url', `${ISSUER}/mod/lti/auth.php`,
    '--auth-token-url', `${ISSUER}/mod/lti/token.php`,
    '--jwks-uri', `${ISSUER}/mod/lti/certs.php`, '--dry-run',
  ], store);
  assert.equal(code, 0);
  assert.equal(store.written.length, 0, 'a dry run must not write');
  const printed = JSON.parse(lines[0]);
  assert.equal(printed.dryRun, true);
  assert.deepEqual(printed.registration.deploymentIds, ['1', '2']);
});

test('P1c: a real run saves exactly the validated row through the store', async () => {
  const store = stubStore();
  const { code, lines } = await run([
    '--from-moodle', ISSUER, '--client-id', 'c1', '--deployment-id', '9',
  ], store);
  assert.equal(code, 0);
  assert.equal(store.written.length, 1);
  assert.deepEqual(store.written[0], {
    issuer: ISSUER,
    clientId: 'c1',
    deploymentIds: ['9'],
    authLoginUrl: `${ISSUER}/mod/lti/auth.php`,
    authTokenUrl: `${ISSUER}/mod/lti/token.php`,
    jwksUri: `${ISSUER}/mod/lti/certs.php`,
  });
  assert.match(lines.join('\n'), /Реєстрацію збережено/);
});

test('P1c: an invalid registration exits 2, names the reason and writes nothing', async () => {
  const store = stubStore();
  const { code, errors } = await run(['--issuer', 'http://m.test', '--client-id', 'c1', '--deployment-id', '1'], store);
  assert.equal(code, 2);
  assert.equal(store.written.length, 0);
  assert.match(errors.join('\n'), /refused: .*https/);
});

test('P1c: the script is wired for `docker compose exec` — the image copies scripts/, and the usage says so', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY scripts \.\/scripts/, 'backend/Dockerfile must copy scripts/ into the image');
  const { USAGE } = require('../../scripts/lti-add-registration');
  assert.match(USAGE, /--from-moodle/);
  assert.match(USAGE, /--dry-run/);
});