// backend/test/integration/keys.test.js
//
// Test-plan scenario 178 (DW-2.2): personal keys are issued once, stored only
// as a SHA-256, listed without a token, never logged, and a revoked one is 403.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const { createKey, sha256Hex } = require('../helpers/keys');

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

let available = false;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  await truncateAll(pool);
});

test.beforeEach(() => failedAuth.reset());

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

const issue = (role, label, as = BOOTSTRAP) => request(app).post('/api/keys').set(as).send({ role, label });

/** Runs `work` while every console method is recorded; returns what was printed. */
async function captureConsole(work) {
  const lines = [];
  const saved = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[method] = console[method];
    console[method] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    await work();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

test('178. issuing a key (DW-2.2)', async t => {
  if (skipUnlessDb(t)) return;

  const res = await issue('author', '  Олена Коваль  ').expect(201);

  await t.test('answers {id, label, role, token} with a trimmed label and no caching', () => {
    assert.deepEqual(Object.keys(res.body).sort(), ['id', 'label', 'role', 'token']);
    assert.equal(res.body.label, 'Олена Коваль');
    assert.equal(res.body.role, 'author');
    assert.ok(res.body.token.length >= 40, 'a token with real entropy');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  await t.test('the database holds a 64-hex SHA-256 of the token, never the token', async () => {
    const { rows } = await pool.query('SELECT * FROM publish_keys WHERE id = $1', [res.body.id]);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
    assert.equal(rows[0].token_hash, sha256Hex(res.body.token));
    assert.ok(!JSON.stringify(rows[0]).includes(res.body.token), 'no column carries the token');
    assert.equal(rows[0].last_used_at, null);
    assert.equal(rows[0].revoked_at, null);
  });

  await t.test('the audit journal records the issue without the token', async () => {
    const { rows } = await pool.query("SELECT * FROM audit_events WHERE action = 'key.create'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_label, 'bootstrap');
    assert.equal(rows[0].scenario_id, null);
    assert.ok(!JSON.stringify(rows[0]).includes(res.body.token));
  });

  await t.test('the issued token authenticates', async () => {
    await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.token}`).expect(200);
  });

  await t.test('two keys never share a token', async () => {
    const other = await issue('author', 'Other').expect(201);
    assert.notEqual(other.body.token, res.body.token);
  });
});

test('178. the list never includes a token or its hash', async t => {
  if (skipUnlessDb(t)) return;
  const made = await issue('moderator', 'Listed').expect(201);

  const list = await request(app).get('/api/keys').set(BOOTSTRAP).expect(200);
  const body = JSON.stringify(list.body);

  assert.ok(!body.includes(made.body.token), 'no token');
  assert.ok(!/token|hash/i.test(body), 'no token or hash field at all');
  const item = list.body.keys.find(k => k.id === made.body.id);
  assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'id', 'label', 'lastUsedAt', 'revokedAt', 'role']);
});

test('178. captured logs never contain a token', async t => {
  if (skipUnlessDb(t)) return;
  let token;

  const logs = await captureConsole(async () => {
    const made = await issue('author', 'Logged').expect(201);
    token = made.body.token;
    const auth = { Authorization: `Bearer ${token}` };
    await request(app).get('/api/auth/me').set(auth).expect(200);
    await request(app).get('/api/admin/scenarios').set(auth).expect(200);
    await request(app).post('/api/keys').set(auth).send({ role: 'author', label: 'x' }).expect(403);
    await request(app).post(`/api/keys/${made.body.id}/revoke`).set(BOOTSTRAP).expect(200);
    await request(app).get('/api/auth/me').set(auth).expect(403);
  });

  assert.ok(token);
  assert.ok(!logs.includes(token), 'the token appeared in a log line');
  assert.ok(!logs.includes(process.env.ADMIN_TOKEN), 'the bootstrap token appeared in a log line');
});

test('178. /api/auth/me answers each kind of principal', async t => {
  if (skipUnlessDb(t)) return;
  const author = await createKey(pool, 'author', 'Me Author');
  const moderator = await createKey(pool, 'moderator', 'Me Moderator');

  await t.test('author', async () => {
    const res = await request(app).get('/api/auth/me').set(author.auth).expect(200);
    assert.deepEqual(res.body, { role: 'author', label: 'Me Author', keyId: author.id });
  });

  await t.test('moderator key', async () => {
    const res = await request(app).get('/api/auth/me').set(moderator.auth).expect(200);
    assert.deepEqual(res.body, { role: 'moderator', label: 'Me Moderator', keyId: moderator.id });
  });

  await t.test('bootstrap token: a moderator with no key id', async () => {
    const res = await request(app).get('/api/auth/me').set(BOOTSTRAP).expect(200);
    assert.deepEqual(res.body, { role: 'moderator', label: 'bootstrap', keyId: null });
  });

  await t.test('no header -> 401; unknown token -> 403', async () => {
    await request(app).get('/api/auth/me').expect(401);
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer nope').expect(403);
  });
});

test('178. revoking a key', async t => {
  if (skipUnlessDb(t)) return;
  const victim = await createKey(pool, 'author', 'Victim');
  await request(app).get('/api/auth/me').set(victim.auth).expect(200);

  const revoked = await request(app).post(`/api/keys/${victim.id}/revoke`).set(BOOTSTRAP).expect(200);

  await t.test('answers the key with its revocation time and still no token', () => {
    assert.equal(revoked.body.id, victim.id);
    assert.ok(Date.parse(revoked.body.revokedAt) > 0);
    assert.ok(!JSON.stringify(revoked.body).includes(victim.token));
  });

  await t.test('/me and every admin route are 403 from then on', async () => {
    await request(app).get('/api/auth/me').set(victim.auth).expect(403);
    await request(app).get('/api/admin/scenarios').set(victim.auth).expect(403);
  });

  await t.test('revoking again keeps the first revocation time (idempotent)', async () => {
    const again = await request(app).post(`/api/keys/${victim.id}/revoke`).set(BOOTSTRAP).expect(200);
    assert.equal(again.body.revokedAt, revoked.body.revokedAt);
  });

  await t.test('the list shows it as revoked', async () => {
    const list = await request(app).get('/api/keys').set(BOOTSTRAP).expect(200);
    assert.ok(list.body.keys.find(k => k.id === victim.id).revokedAt);
  });

  await t.test('an unknown id is 404, a malformed or oversized one is 400', async () => {
    await request(app).post('/api/keys/999999/revoke').set(BOOTSTRAP).expect(404);
    await request(app).post('/api/keys/abc/revoke').set(BOOTSTRAP).expect(400);
    await request(app).post('/api/keys/-1/revoke').set(BOOTSTRAP).expect(400);
    await request(app).post('/api/keys/99999999999/revoke').set(BOOTSTRAP).expect(400);
    await request(app).post('/api/keys/1.5/revoke').set(BOOTSTRAP).expect(400);
  });
});

test('178. a moderator key manages keys; an author key cannot', async t => {
  if (skipUnlessDb(t)) return;
  const moderator = await createKey(pool, 'moderator', 'Key Admin');
  const author = await createKey(pool, 'author', 'Key Seeker');

  const made = await issue('author', 'By a key', moderator.auth).expect(201);
  const audit = await pool.query("SELECT actor_key_id, actor_label FROM audit_events WHERE action = 'key.create' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(audit.rows[0], { actor_key_id: moderator.id, actor_label: 'Key Admin' });
  assert.ok(made.body.token);

  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM publish_keys')).rows[0].n;
  await issue('author', 'By an author', author.auth).expect(403);
  await request(app).get('/api/keys').set(author.auth).expect(403);
  await request(app).post(`/api/keys/${moderator.id}/revoke`).set(author.auth).expect(403);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM publish_keys')).rows[0].n, before);
});

test('178. key input validation (DW-2.2)', async t => {
  if (skipUnlessDb(t)) return;
  const before = () => pool.query('SELECT COUNT(*)::int AS n FROM publish_keys').then(r => r.rows[0].n);
  const start = await before();

  const bad = [
    ['role "admin"', { role: 'admin', label: 'x' }],
    ['role missing', { label: 'x' }],
    ['role not a string', { role: ['author'], label: 'x' }],
    ['label missing', { role: 'author' }],
    ['label empty', { role: 'author', label: '' }],
    ['label only spaces', { role: 'author', label: '   ' }],
    ['label of 101 characters', { role: 'author', label: 'x'.repeat(101) }],
    ['label not a string', { role: 'author', label: 123 }],
  ];
  for (const [name, body] of bad) {
    await t.test(`${name} -> 400, nothing created`, async () => {
      await request(app).post('/api/keys').set(BOOTSTRAP).send(body).expect(400);
    });
  }

  await t.test('no key was created by any of them', async () => {
    assert.equal(await before(), start);
  });

  await t.test('a label of exactly 100 characters is accepted', async () => {
    await issue('moderator', 'x'.repeat(100)).expect(201);
  });

  await t.test('an empty body is 400, not a crash', async () => {
    await request(app).post('/api/keys').set(BOOTSTRAP).expect(400);
  });
});
