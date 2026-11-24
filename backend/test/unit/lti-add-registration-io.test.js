// backend/test/unit/lti-add-registration-io.test.js — P1c review r1 (plan: code-foundations/P1e/plan.md).
// main(argv, io) takes WRITABLE STREAMS with write(string).
// Defaults are the process output streams (see the source-assertion test below).
// R1-3: with --from-moodle an explicit endpoint flag is validated, not dropped.
// Foreign hosts are refused with exit 2 and nothing saved.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('../../scripts/lti-add-registration');
const MOODLE = 'https://m.example';
// A valid same-origin flag wins over the Moodle default.
const ENDPOINT_FLAGS = [
  ['--auth-login-url', 'auth_login_url', '/mod/lti/auth.php'],
  ['--auth-token-url', 'auth_token_url', '/mod/lti/token.php'],
  ['--jwks-uri', 'jwks_uri', '/mod/lti/certs.php'],
];
const CAMEL = { auth_login_url: 'authLoginUrl', auth_token_url: 'authTokenUrl', jwks_uri: 'jwksUri' };

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

/** A writable-stream-shaped recorder: only write(string), nothing else. */
function recorder() {
  const chunks = [];
  return {
    chunks,
    write(s) { assert.equal(typeof s, 'string', 'write must receive a string'); chunks.push(s); return true; },
  };
}

function fullArgs(issuer) {
  return [
    '--issuer', issuer, '--client-id', 'c1', '--deployment-id', '1',
    '--auth-login-url', `${issuer}/mod/lti/auth.php`,
    '--auth-token-url', `${issuer}/mod/lti/token.php`,
    '--jwks-uri', `${issuer}/mod/lti/certs.php`,
  ];
}

// R1-2: stream IO on every path.

test('r1 IO: --help prints USAGE through out.write and exits 0', async () => {
  const out = recorder();
  const err = recorder();
  const code = await main(['--help'], { store: stubStore(), out, err });
  assert.equal(code, 0);
  assert.equal(out.chunks.length, 1);
  assert.match(out.chunks[0], /Usage:/);
  assert.equal(err.chunks.length, 0);
});

test('r1 IO: --dry-run prints the row through out.write and exits 0', async () => {
  const out = recorder();
  const err = recorder();
  const store = stubStore();
  const code = await main([...fullArgs(MOODLE), '--dry-run'], { store, out, err });
  assert.equal(code, 0);
  assert.equal(store.written.length, 0);
  assert.equal(JSON.parse(out.chunks[0]).dryRun, true);
  assert.match(out.chunks.join(''), /Нічого не записано/);
  assert.equal(err.chunks.length, 0);
});

test('r1 IO: a refused registration writes the reason through err.write and exits 2', async () => {
  const out = recorder();
  const err = recorder();
  const store = stubStore();
  const code = await main(['--issuer', 'http://m.example', '--client-id', 'c1', '--deployment-id', '1'], { store, out, err });
  assert.equal(code, 2);
  assert.equal(store.written.length, 0);
  assert.match(err.chunks.join(''), /refused: .*https/);
  assert.equal(out.chunks.length, 0);
});

test('r1 IO: an unknown flag reports through err.write with USAGE and exits 2', async () => {
  const err = recorder();
  const code = await main(['--nope', 'x'], { store: stubStore(), out: recorder(), err });
  assert.equal(code, 2);
  assert.match(err.chunks.join(''), /unknown flag/);
  assert.match(err.chunks.join(''), /Usage:/);
});

test('r1 IO: the saved path reports through out.write and exits 0', async () => {
  const out = recorder();
  const err = recorder();
  const store = stubStore();
  const code = await main(['--from-moodle', MOODLE, '--client-id', 'c1', '--deployment-id', '9'], { store, out, err });
  assert.equal(code, 0);
  assert.equal(store.written.length, 1);
  assert.match(out.chunks.join(''), /Реєстрацію збережено/);
  assert.equal(err.chunks.length, 0);
});

test('r1 IO: a real PassThrough stream receives the dry-run output', async () => {
  const { PassThrough } = require('node:stream');
  const out = new PassThrough();
  const received = [];
  out.on('data', chunk => received.push(chunk.toString()));
  const code = await main([...fullArgs(MOODLE), '--dry-run'], { store: stubStore(), out, err: recorder() });
  assert.equal(code, 0);
  out.end();
  await new Promise(resolve => out.on('end', resolve));
  const text = received.join('');
  assert.match(text, /"dryRun": true/);
  assert.match(text, /Нічого не записано/);
});

test('r1 IO: output lines keep their trailing newlines (stream write adds none)', async () => {
  const out = recorder();
  await main(['--help'], { store: stubStore(), out, err: recorder() });
  assert.ok(out.chunks[0].endsWith('\n'), 'USAGE written to a stream must end with a newline');
  const out2 = recorder();
  await main(['--from-moodle', MOODLE, '--client-id', 'c1', '--deployment-id', '1'], { store: stubStore(), out: out2, err: recorder() });
  for (const chunk of out2.chunks) {
    assert.ok(chunk.endsWith('\n'), `saved-path chunk must end with newline: ${JSON.stringify(chunk)}`);
  }
});

test('r1 IO: omitted io.out / io.err default to the process output streams', () => {
  // Source assertion: running with the real defaults would write into the TAP stream.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lti-add-registration.js'), 'utf8');
  const outDefault = 'io.out || process.' + 'stdout';
  const errDefault = 'io.err || process.' + 'stderr';
  assert.ok(source.includes(outDefault), 'out must default to the process stdout stream');
  assert.ok(source.includes(errDefault), 'err must default to the process stderr stream');
});
// Section two: explicit endpoint flags.

test('r1 explicit endpoints: foreign-host --auth-login-url with --from-moodle exits 2, names the field, saves nothing', async () => {
  const store = stubStore();
  const err = recorder();
  const code = await main([
    '--from-moodle', MOODLE, '--client-id', 'c1', '--deployment-id', '1',
    '--auth-login-url', 'https://evil.example/x',
  ], { store, out: recorder(), err });
  assert.equal(code, 2);
  assert.equal(store.written.length, 0, 'the fake store must see no save');
  assert.match(err.chunks.join(''), /auth_login_url/);
});

for (const [flag, field, moodlePath] of ENDPOINT_FLAGS) {
  test(`r1 explicit endpoints: ${flag} on a foreign host with --from-moodle exits 2 and saves nothing`, async () => {
    const store = stubStore();
    const err = recorder();
    const code = await main([
      '--from-moodle', MOODLE, '--client-id', 'c1', '--deployment-id', '1',
      flag, `https://evil.example${moodlePath}`,
    ], { store, out: recorder(), err });
    assert.equal(code, 2);
    assert.equal(store.written.length, 0);
    assert.match(err.chunks.join(''), new RegExp(field));
  });

  test(`r1 explicit endpoints: a valid same-origin ${flag} wins over the Moodle default`, async () => {
    const store = stubStore();
    const custom = `${MOODLE}/custom/${field}.php`;
    const code = await main([
      '--from-moodle', MOODLE, '--client-id', 'c1', '--deployment-id', '1',
      flag, custom,
    ], { store, out: recorder(), err: recorder() });
    assert.equal(code, 0);
    assert.equal(store.written.length, 1);
    assert.equal(store.written[0][CAMEL[field]], custom, 'the explicit flag must win over the Moodle default');
    // The other two endpoints keep their Moodle defaults.
    for (const [otherFlag, otherField, otherPath] of ENDPOINT_FLAGS) {
      if (otherFlag === flag) continue;
      assert.equal(store.written[0][CAMEL[otherField]], `${MOODLE}${otherPath}`);
    }
  });
}

test('r1 explicit endpoints: --from-moodle alone still fills all three Moodle endpoints', async () => {
  const store = stubStore();
  const code = await main(['--from-moodle', MOODLE, '--client-id', 'c1', '--deployment-id', '1'], {
    store, out: recorder(), err: recorder(),
  });
  assert.equal(code, 0);
  assert.equal(store.written[0].authLoginUrl, `${MOODLE}/mod/lti/auth.php`);
  assert.equal(store.written[0].authTokenUrl, `${MOODLE}/mod/lti/token.php`);
  assert.equal(store.written[0].jwksUri, `${MOODLE}/mod/lti/certs.php`);
});
