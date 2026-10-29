// backend/test/unit/workflow.test.js
//
// Test-plan scenario 194 (DW-3.2, DW-3.5, DW-3.6): the pure parts of the publishing workflow
// - the transition table's shape, the reject note rules, `sendError`'s mapping, the
// `optionalAuthenticate` paths that need no database, and the `from-archive` id pattern.
// The routines that need a row lock (`applyTransition`, `installUpload`, ...) are
// tested against a real Postgres in the integration files (the project uses no DB mocks).

const test = require('node:test');
const assert = require('node:assert/strict');

const { TRANSITIONS, parseRejectNote, MAX_NOTE_LENGTH, DEFAULT_REJECT_NOTE } = require('../../workflow');
const { httpError, sendError } = require('../../http-error');
const { optionalAuthenticate } = require('../../auth');
const { SCENARIO_ID_PATTERN } = require('../../catalog-input');

const STATUSES = ['draft', 'review', 'published', 'rejected'];

test('194. the transition table: five actions, valid statuses, published only through approve', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), ['approve', 'reject', 'submit', 'unpublish', 'withdraw']);
  for (const [action, rule] of Object.entries(TRANSITIONS)) {
    assert.ok(STATUSES.includes(rule.to), `${action} targets a real status`);
    for (const from of rule.from) assert.ok(STATUSES.includes(from), `${action} starts from a real status`);
    assert.ok(!rule.from.includes(rule.to), `${action} always moves`);
    assert.ok(['owner', 'moderator'].includes(rule.by));
  }
  assert.deepEqual(Object.entries(TRANSITIONS).filter(([, r]) => r.to === 'published').map(([a]) => a), ['approve']);
  assert.deepEqual(TRANSITIONS.approve.from, ['review', 'draft', 'rejected']);
  assert.deepEqual(TRANSITIONS.submit.from, ['draft', 'rejected']);
  assert.deepEqual(TRANSITIONS.unpublish.from, ['published']);
  assert.equal(TRANSITIONS.unpublish.to, 'draft');
  assert.equal(TRANSITIONS.approve.by, 'moderator');
  assert.equal(TRANSITIONS.submit.by, 'owner');
});

test('194. approve and submit need an archive, nothing else does', () => {
  const needing = Object.entries(TRANSITIONS).filter(([, r]) => r.needsVersion).map(([a]) => a).sort();
  assert.deepEqual(needing, ['approve', 'submit']);
});

test('194. parseRejectNote: default, trim, 2000 limit, type', async t => {
  assert.equal(DEFAULT_REJECT_NOTE, 'Потрібні уточнення від модератора.');
  assert.equal(MAX_NOTE_LENGTH, 2000);

  await t.test('missing, null, empty and blank give the default', () => {
    for (const raw of [undefined, null, '', '   ', '\n\t']) assert.deepEqual(parseRejectNote(raw), { value: DEFAULT_REJECT_NOTE });
  });
  await t.test('text is trimmed and kept', () => {
    assert.deepEqual(parseRejectNote('  Додайте опис  '), { value: 'Додайте опис' });
  });
  await t.test('2000 passes, 2001 is an error; the limit applies after trimming', () => {
    assert.equal(parseRejectNote('я'.repeat(2000)).value.length, 2000);
    assert.match(parseRejectNote('я'.repeat(2001)).error, /2000/);
    assert.equal(parseRejectNote(` ${'я'.repeat(2000)} `).value.length, 2000);
  });
  await t.test('anything that is not a string is an error', () => {
    for (const raw of [0, 1, true, {}, ['a']]) assert.ok(parseRejectNote(raw).error, String(raw));
  });
});

function fakeRes() {
  const res = { headers: {}, code: null, body: null };
  res.status = code => { res.code = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

test('194. sendError: a 4xx status answers as itself, anything else is a 500 with no detail', async t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));

  await t.test('httpError', () => {
    const res = fakeRes();
    sendError(res, httpError(409, 'Конфлікт'), 'X');
    assert.deepEqual([res.code, res.body], [409, { error: 'Конфлікт' }]);
  });
  await t.test('an error with a 4xx status (the archive validator\'s) keeps it', () => {
    const res = fakeRes();
    sendError(res, Object.assign(new Error('bad zip'), { status: 400 }), 'X');
    assert.deepEqual([res.code, res.body.error], [400, 'bad zip']);
  });
  await t.test('an unexpected error is a logged 500 that does not leak its message', () => {
    const res = fakeRes();
    sendError(res, new Error('relation "secret" does not exist'), 'X');
    assert.deepEqual([res.code, res.body], [500, { error: 'Помилка сервера' }]);
    assert.equal(logged.length, 1);
  });
  await t.test('a 5xx status is not echoed', () => {
    const res = fakeRes();
    sendError(res, httpError(503, 'down for maintenance'), 'X');
    assert.equal(res.code, 500);
  });
});

test('194. optionalAuthenticate: no credential or the bootstrap one need no lookup', async t => {
  const run = async headers => {
    const req = { ip: '203.0.113.9', get: name => headers[name.toLowerCase()] };
    const res = fakeRes();
    let passed = false;
    await optionalAuthenticate(req, res, () => { passed = true; });
    return { req, res, passed };
  };

  await t.test('no header -> anonymous, passes', async () => {
    const { req, passed, res } = await run({});
    assert.equal(passed, true);
    assert.equal(req.principal, undefined);
    assert.equal(res.code, null);
  });
  await t.test('a scheme other than Bearer is anonymous, not an error', async () => {
    const { passed, req } = await run({ authorization: 'Basic abc' });
    assert.equal(passed, true);
    assert.equal(req.principal, undefined);
  });
  await t.test('the bootstrap token -> a moderator principal', async () => {
    process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'unit-test-token';
    const { passed, req } = await run({ authorization: `Bearer ${process.env.ADMIN_TOKEN}` });
    assert.equal(passed, true);
    assert.deepEqual(req.principal, { role: 'moderator', keyId: null, label: 'bootstrap' });
  });
  await t.test('an over-long token is anonymous without a lookup', async () => {
    const { passed, req } = await run({ authorization: `Bearer ${'x'.repeat(600)}` });
    assert.equal(passed, true);
    assert.equal(req.principal, undefined);
  });
});

test('194. SCENARIO_ID_PATTERN accepts slugs of 2-100 characters only', () => {
  for (const ok of ['ab', 'a1', 'solar-system', '0-0', 'a'.repeat(100)]) assert.ok(SCENARIO_ID_PATTERN.test(ok), ok);
  for (const bad of ['', 'a', 'a'.repeat(101), '-ab', 'Ab', 'a b', 'a.b', 'a/b', 'a_b', 'a\nb', 'аб', 'ab\n']) {
    assert.ok(!SCENARIO_ID_PATTERN.test(bad), JSON.stringify(bad));
  }
});
