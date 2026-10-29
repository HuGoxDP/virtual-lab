// backend/test/unit/auth-and-limits.test.js
//
// Test-plan scenario 186 (DW-2.2, DW-2.3, DW-2.6): the pure routines behind
// personal keys — role checks, ownership, the window counter, the upload
// limiter and the env parsing of the caps. No database, no HTTP.

const test = require('node:test');
const assert = require('node:assert/strict');

const { requireRole, canEditScenario, sha256Hex } = require('../../auth');
const { createWindowCounter, limitAuthorUploads, authorUploads } = require('../../rate-limits');
const { parsePositiveInt } = require('../../config');
const { forbiddenAuthorFields, AUTHOR_FORBIDDEN_FIELDS } = require('../../catalog-input');

/** A minimal response double that records status, body and headers. */
function fakeRes() {
  const res = { headers: {} };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.set = (name, value) => { res.headers[name] = value; return res; };
  return res;
}

function run(middleware, req) {
  const res = fakeRes();
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return { res, passed };
}

test('186. sha256Hex is the 64-hex digest of the token', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(sha256Hex('anything'), /^[0-9a-f]{64}$/);
});

test('186. requireRole ranks moderator above author', async t => {
  const as = role => ({ principal: { role, keyId: 1, label: 'x' } });

  await t.test('an author passes author but not moderator', () => {
    assert.equal(run(requireRole('author'), as('author')).passed, true);
    const denied = run(requireRole('moderator'), as('author'));
    assert.equal(denied.passed, false);
    assert.equal(denied.res.statusCode, 403);
  });

  await t.test('a moderator passes both', () => {
    assert.equal(run(requireRole('author'), as('moderator')).passed, true);
    assert.equal(run(requireRole('moderator'), as('moderator')).passed, true);
  });

  await t.test('no principal is 401, never a pass', () => {
    const denied = run(requireRole('author'), {});
    assert.equal(denied.passed, false);
    assert.equal(denied.res.statusCode, 401);
  });
});

test('186. canEditScenario: moderators edit anything, authors only what they own', async t => {
  const author = { role: 'author', keyId: 7, label: 'a' };
  const moderator = { role: 'moderator', keyId: 9, label: 'm' };
  const bootstrap = { role: 'moderator', keyId: null, label: 'bootstrap' };

  assert.equal(canEditScenario(author, { owner_key_id: 7 }), true);
  assert.equal(canEditScenario(author, { owner_key_id: 8 }), false);

  await t.test('an unowned row is a moderator-only row', () => {
    assert.equal(canEditScenario(author, { owner_key_id: null }), false);
    assert.equal(canEditScenario(moderator, { owner_key_id: null }), true);
    assert.equal(canEditScenario(bootstrap, { owner_key_id: 3 }), true);
  });

  await t.test('a principal with no key never matches a null owner', () => {
    assert.equal(canEditScenario({ role: 'author', keyId: null, label: 'x' }, { owner_key_id: null }), false);
  });
});

test('186. createWindowCounter', async t => {
  await t.test('allows `limit` slots, then refuses without counting further', () => {
    const counter = createWindowCounter({ limit: 2, windowMs: 1000 });
    assert.deepEqual([1, 2, 3, 4].map(() => counter.consume('k')), [true, true, false, false]);
  });

  await t.test('keys are independent', () => {
    const counter = createWindowCounter({ limit: 1, windowMs: 1000 });
    assert.equal(counter.consume('a'), true);
    assert.equal(counter.consume('b'), true);
    assert.equal(counter.consume('a'), false);
  });

  await t.test('the window reopens once it has expired', () => {
    let time = 0;
    const counter = createWindowCounter({ limit: 1, windowMs: 1000, now: () => time });
    assert.equal(counter.consume('k'), true);
    time = 999;
    assert.equal(counter.consume('k'), false);
    time = 1000;
    assert.equal(counter.consume('k'), true);
  });

  await t.test('retryAfterSeconds counts down to the reset, at least 1', () => {
    let time = 0;
    const counter = createWindowCounter({ limit: 1, windowMs: 10_000, now: () => time });
    assert.equal(counter.retryAfterSeconds('unseen'), 1);
    counter.consume('k');
    time = 2500;
    assert.equal(counter.retryAfterSeconds('k'), 8);
    time = 9999.9;
    assert.equal(counter.retryAfterSeconds('k'), 1);
  });

  await t.test('reset forgets every window', () => {
    const counter = createWindowCounter({ limit: 1, windowMs: 1000 });
    counter.consume('k');
    counter.reset();
    assert.equal(counter.consume('k'), true);
  });
});

test('186. limitAuthorUploads', async t => {
  t.beforeEach(() => authorUploads.reset());
  t.after(() => authorUploads.reset());

  await t.test('exempts moderator keys and the bootstrap token', () => {
    for (const principal of [{ role: 'moderator', keyId: 4, label: 'm' }, { role: 'moderator', keyId: null, label: 'bootstrap' }]) {
      for (let i = 0; i < 50; i++) assert.equal(run(limitAuthorUploads, { principal }).passed, true);
    }
  });

  await t.test('an author key is answered 429 with Retry-After past the limit, other keys unaffected', () => {
    const alice = { principal: { role: 'author', keyId: 1, label: 'a' } };
    const bob = { principal: { role: 'author', keyId: 2, label: 'b' } };
    let last;
    for (let i = 0; i < 21; i++) last = run(limitAuthorUploads, alice);
    assert.equal(last.passed, false);
    assert.equal(last.res.statusCode, 429);
    assert.ok(Number(last.res.headers['Retry-After']) >= 1);
    assert.equal(run(limitAuthorUploads, bob).passed, true);
  });
});

test('186. parsePositiveInt falls back on anything that is not a positive safe integer', () => {
  assert.equal(parsePositiveInt('5', 9), 5);
  for (const bad of [undefined, '', 'abc', '0', '-3', '1.5', 'Infinity', '9007199254740993']) {
    assert.equal(parsePositiveInt(bad, 9), 9, String(bad));
  }
});

test('186. forbiddenAuthorFields names exactly the fields an author may not send', async t => {
  await t.test('each forbidden field and any archive* key', () => {
    for (const field of [...AUTHOR_FORBIDDEN_FIELDS, 'archiveSha256', 'archiveBytes']) {
      assert.deepEqual(forbiddenAuthorFields({ title: 'T', [field]: 1 }), [field], field);
    }
  });

  await t.test('content fields and categoryLabel are clean; a missing body is clean', () => {
    const body = { title: 't', description: 'd', fullDescription: 'f', category: 'c', version: '1', features: [], categoryLabel: 'x' };
    assert.deepEqual(forbiddenAuthorFields(body), []);
    assert.deepEqual(forbiddenAuthorFields(undefined), []);
  });

  await t.test('reports every offender, in the order sent', () => {
    assert.deepEqual(forbiddenAuthorFields({ author: 'x', isPublished: true }), ['author', 'isPublished']);
  });
});
