// backend/test/unit/lti-add-registration-p1f.test.js — MS-2 AC-19 (P1f).
//
// The `lti_registrations` row is a TRUST ANCHOR: `launch.js` answers 403 «Платформа не
// зареєстрована» for any issuer it has no exact-match row for, so a row the admin typed wrong
// 403s on every launch and looks like a platform problem instead of a typo. The parser of
// `scripts/lti-add-registration.js` is where the row is trusted, and P1c left it lenient:
//
//   * a repeated `--deployment-id` kept only the LAST value (`args[key] = value`) — a second
//     deployment Moodle also sends was silently dropped;
//   * any repeated value flag (`--client-id a --client-id b`) silently overwrote the first;
//   * `--dry-run=false` was accepted and still turned dry-run ON (the inline value was ignored);
//   * `--from-moodle https://h/moodle?x=1` built endpoints INSIDE the query string and exited 0.
//
// AC-19: every `--deployment-id` given is stored, repeats accumulate in order; a repeat of any
// other value flag returns 2 naming the flag; `--dry-run=<anything>` returns 2 naming
// `--dry-run` (a boolean flag takes no value); a `--from-moodle` base with a query string or
// fragment returns 2 naming `--from-moodle`; in every refused case nothing is saved.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs, registrationFromArgs, fromMoodle, main } =
  require('../../scripts/lti-add-registration');

const MOODLE = 'https://m.example';

/** Every value flag except the one that is meant to accumulate. */
const SINGLE_VALUE_FLAGS = [
  '--issuer',
  '--client-id',
  '--auth-login-url',
  '--auth-token-url',
  '--jwks-uri',
  '--from-moodle',
];

/** A store that records what the script would write. */
function stubStore() {
  const written = [];
  return {
    written,
    async saveRegistration(row) { written.push(row); },
  };
}

/** A writable-stream-shaped recorder: only write(string), nothing else. */
function recorder() {
  const lines = [];
  return {
    lines,
    write(text) { lines.push(text); return true; },
    text() { return lines.join(''); },
  };
}

/** Runs `main` through recursive argv with two in-memory streams and a stub store. */
async function run(argv, options = {}) {
  const out = recorder();
  const err = recorder();
  const store = options.store || stubStore();
  const code = await main(argv, { store, out, err });
  return { code, out: out.text(), err: err.text(), store };
}

/** Every flag a `--from-moodle` registration needs, so refusals isolate the flag under test. */
function moodleFlags(extra = []) {
  return ['--from-moodle', MOODLE, '--client-id', 'c1', '--deployment-id', '1', ...extra];
}

// ── DW-1.1: repeated --deployment-id accumulates in order ───────────

test('AC-19: every --deployment-id is stored, repeats accumulate in order', async () => {
  const store = stubStore();
  const { code, out } = await run(moodleFlags(['--deployment-id', '2', '--deployment-id', '3']), { store });

  assert.equal(code, 0);
  assert.equal(store.written.length, 1);
  assert.deepEqual(store.written[0].deploymentIds, ['1', '2', '3']);
  assert.match(out, /deployment_id: 1, 2, 3/);
});

test('AC-19: --deployment-id=<v> accumulates too, and the second run adds nothing', async () => {
  const store = stubStore();
  const { code } = await run(
    ['--from-moodle', MOODLE, '--client-id', 'c1', '--deployment-id=alpha', '--deployment-id=beta'],
    { store },
  );

  assert.equal(code, 0);
  assert.deepEqual(store.written[0].deploymentIds, ['alpha', 'beta']);
});

test('AC-19: a single --deployment-id still stores a one-element row', async () => {
  const store = stubStore();
  const { code } = await run(moodleFlags(), { store });

  assert.equal(code, 0);
  assert.deepEqual(store.written[0].deploymentIds, ['1']);
});

test('AC-19: parseArgs keeps deploymentIds as a string for one flag and an array for several', () => {
  assert.equal(parseArgs(moodleFlags()).deploymentIds, '1');
  assert.deepEqual(parseArgs(moodleFlags(['--deployment-id', '2'])).deploymentIds, ['1', '2']);
  assert.deepEqual(
    parseArgs(moodleFlags(['--deployment-id=2', '--deployment-id=3'])).deploymentIds,
    ['1', '2', '3'],
  );
});

// ── DW-1.2: a repeat of any other value flag is refused ─────────────

test('AC-19: a repeated value flag returns 2, names the flag, and saves nothing', async () => {
  for (const flag of SINGLE_VALUE_FLAGS) {
    const value = 'https://m.example';
    const store = stubStore();
    const { code, err } = await run(
      [...moodleFlags(), flag, value, flag, value],
      { store },
    );
    assert.equal(code, 2, flag);
    assert.match(err, new RegExp(`repeated flag: ${flag.replace(/[-/\^$*+?.()|[\]{}]/g, '\$&')}`), flag);
    // nothing saved — the refusal happens in parseArgs, before any store call
    assert.deepEqual(store.written, [], flag);
  }
});

test('AC-19: the refusal is per-flag, not per-key: --client-id repeated both ways', async () => {
  for (const argv of [
    ['--client-id', 'c1', '--client-id', 'c2'],
    ['--client-id=c1', '--client-id=c2'],
  ]) {
    const { code, err } = await run(moodleFlags(argv));
    assert.equal(code, 2);
    assert.match(err, /repeated flag: --client-id/);
  }
});

// ── DW-1.3: a boolean flag takes no value ──────────────────────────

test('AC-19: --dry-run=<anything> returns 2 naming --dry-run and saves nothing', async () => {
  for (const argv of [['--dry-run=true'], ['--dry-run=false'], ['--dry-run=1'], ['--dry-run=']]) {
    const store = stubStore();
    const { code, err } = await run(moodleFlags(argv), { store });

    assert.equal(code, 2);
    assert.match(err, /--dry-run does not take a value/);
    assert.deepEqual(store.written, [], argv.join(' '));
  }
});

test('AC-19: a value for --help is refused too, but --dry-run alone still works', async () => {
  const booleanRefused = await run(moodleFlags(['--help=x']));
  assert.equal(booleanRefused.code, 2);
  assert.match(booleanRefused.err, /--help does not take a value/);

  const dry = await run(moodleFlags(['--dry-run']));
  assert.equal(dry.code, 0);
  assert.match(dry.out, /dry-run: would save registration/);
  assert.deepEqual(dry.store.written, []);
});

// ── DW-1.4: a --from-moodle base with ? or # is refused ────────────

test('AC-19: a --from-moodle base carrying a query or fragment returns 2 naming it, saving nothing', async () => {
  for (const base of [
    'https://m.example/moodle?x=1',
    'https://m.example/moodle#frag',
    'https://m.example?x=1',
    'https://m.example#',
    'https://m.example/moodle/?x=1',
  ]) {
    const store = stubStore();
    const { code, err } = await run([
      '--from-moodle', base, '--client-id', 'c1', '--deployment-id', '1',
    ], { store });

    assert.equal(code, 2, base);
    assert.match(err, /--from-moodle base URL must not contain query or fragment/, base);
    assert.deepEqual(store.written, [], base);
  }
});

test('AC-19: fromMoodle() refuses a query or fragment in any position', () => {
  assert.equal(fromMoodle('https://m.example/moodle').authLoginUrl, `${MOODLE}/moodle/mod/lti/auth.php`);
  assert.throws(() => fromMoodle('https://m.example/moodle?a=1'), /--from-moodle base URL must not contain query or fragment/);
  assert.throws(() => fromMoodle('https://m.example#here'), /--from-moodle base URL must not contain query or fragment/);
  assert.throws(() => fromMoodle('https://m.example:8443/moodle?a=b#c'), /--from-moodle base URL must not contain query or fragment/);
});

test('AC-19: a clean --from-moodle base with a sub-path and a port still builds the endpoints', () => {
  const base = 'https://m.example:8443/moodle';
  assert.deepEqual(fromMoodle(`${base}/`), {
    authLoginUrl: 'https://m.example:8443/moodle/mod/lti/auth.php',
    authTokenUrl: 'https://m.example:8443/moodle/mod/lti/token.php',
    jwksUri: 'https://m.example:8443/moodle/mod/lti/certs.php',
  });
});

// ── in every refused case nothing is saved ─────────────────────────

test('AC-19: refused input reaches no store call — the refusal precedes every branch that writes', async () => {
  // The valid baseline still reaches the store: one deployment, one saveRegistration call.
  const baseline = stubStore();
  const ok = await run(moodleFlags(), { store: baseline });
  assert.equal(ok.code, 0);
  assert.equal(baseline.written.length, 1);

  // Every refusal path below hands the store nothing.
  const refusals = [
    // a repeat of another value flag (issuer is not among the Moodle defaults)
    [...moodleFlags(), '--issuer', 'https://o.example', '--issuer', 'https://o.example'],
    // --dry-run= takes no value
    moodleFlags(['--dry-run=']),
    // a --from-moodle base carrying a query or a fragment
    ['--from-moodle', 'https://m.example/moodle?x=1', '--client-id', 'c1', '--deployment-id', '1'],
    ['--from-moodle', 'https://m.example/moodle#frag', '--client-id', 'c1', '--deployment-id', '1'],
  ];
  for (const argv of refusals) {
    const store = stubStore();
    const res = await run(argv, { store });
    assert.equal(res.code, 2);
    assert.equal(store.written.length, 0);
  }
});
