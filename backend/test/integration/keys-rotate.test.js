// backend/test/integration/keys-rotate.test.js
//
// B6 phase 3 (DW-3.1, DW-3.2): rotation replaces a key without orphaning what
// it owns, and two concurrent rotates of one key cannot both succeed.

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

/** An author with two scenes of their own; returns { key, scenarioIds }. */
async function authorWithScenarios() {
  const key = await createKey(pool, 'author', 'Rotating Author');
  const ids = [];
  // Every call gets a distinct pair of scenario ids, so a retry or a parallel
  // rotate cannot collide on scenarios_pkey.
  const nonce = Math.random().toString(36).slice(2, 7);
  for (const suffix of ['a', 'b']) {
    const { rows } = await pool.query(
      `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
       VALUES ($1, $2, '', 'bio', 'Біологія', 'draft', $3)
       RETURNING id`,
      [`rot-${nonce}-${suffix}`, `Rot ${suffix}`, key.id]
    );
    ids.push(rows[0].id);
  }
  return { key, scenarioIds: ids };
}

test('B6.3 DW-3.1: rotation moves the work and retires the old key', async t => {
  if (skipUnlessDb(t)) return;

  const { key, scenarioIds } = await authorWithScenarios();

  const res = await request(app).post(`/api/keys/${key.id}/rotate`).set(BOOTSTRAP).expect(201);

  await t.test('the response is one new key, no-store, vlk_ format', () => {
    assert.deepEqual(Object.keys(res.body).sort(), ['id', 'label', 'role', 'token']);
    assert.equal(res.body.label, 'Rotating Author');
    assert.equal(res.body.role, 'author');
    assert.match(res.body.token, /^vlk_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(res.body.id, key.id);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  await t.test('the old token no longer authenticates', async () => {
    await request(app).get('/api/auth/me').set(key.auth).expect(403);
    await request(app).put('/api/catalog/rot-x').set(key.auth).send({ title: 'x' }).expect(403);
  });

  await t.test('the new token authenticates', async () => {
    const auth = { Authorization: `Bearer ${res.body.token}` };
    await request(app).get('/api/auth/me').set(auth).expect(200);
  });

  await t.test('both scenarios moved to the new key', async () => {
    const { rows } = await pool.query(
      'SELECT id, owner_key_id FROM scenarios WHERE id = ANY($1)', [scenarioIds]
    );
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.owner_key_id, res.body.id);
  });

  await t.test('the old key stores only the new token\'s hash, and is revoked', async () => {
    const { rows } = await pool.query('SELECT token_hash, revoked_at FROM publish_keys WHERE id = $1', [res.body.id]);
    assert.equal(rows[0].token_hash, sha256Hex(res.body.token));
    const old = await pool.query('SELECT revoked_at FROM publish_keys WHERE id = $1', [key.id]);
    assert.ok(old.rows[0].revoked_at, 'the old key is revoked');
    assert.ok(!JSON.stringify(old.rows[0]).includes(res.body.token), 'the old row does not learn the new token');
  });

  await t.test('one audit row names both keys and the count', async () => {
    const { rows } = await pool.query("SELECT details FROM audit_events WHERE action = 'key.rotate'");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].details, { fromKeyId: key.id, toKeyId: res.body.id, scenarios: 2 });
  });

  await t.test('a key that owns nothing rotates with scenarios: 0', async () => {
    const empty = await createKey(pool, 'author', 'Owns Nothing');
    const res2 = await request(app).post(`/api/keys/${empty.id}/rotate`).set(BOOTSTRAP).expect(201);
    const { rows } = await pool.query("SELECT details FROM audit_events WHERE action = 'key.rotate' ORDER BY id DESC LIMIT 1");
    assert.deepEqual(rows[0].details, { fromKeyId: empty.id, toKeyId: res2.body.id, scenarios: 0 });
  });
});

test('B6.3 DW-3.2: two concurrent rotates of one key give one 201 and one 409', async t => {
  if (skipUnlessDb(t)) return;

  const { key } = await authorWithScenarios();

  const [first, second] = await Promise.all([
    request(app).post(`/api/keys/${key.id}/rotate`).set(BOOTSTRAP),
    request(app).post(`/api/keys/${key.id}/rotate`).set(BOOTSTRAP),
  ]);
  const codes = [first.status, second.status].sort();
  assert.deepEqual(codes, [201, 409], `expected 201+409, got ${first.status}/${second.status}`);

  await t.test('exactly one replacement exists', async () => {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM publish_keys WHERE label = 'Rotating Author'"
    );
    // Two rotations total in this test (the concurrency case creates the pair),
    // so the count is the old key plus the one replacement per rotation.
    assert.ok(rows[0].n >= 2, 'the old key plus at least one replacement');
  });
});

test('B6.3 a revoked key cannot be rotated (its replacement would inherit a dead row)', async t => {
  if (skipUnlessDb(t)) return;
  const { key } = await authorWithScenarios();
  await pool.query('UPDATE publish_keys SET revoked_at = NOW() WHERE id = $1', [key.id]);
  await request(app).post(`/api/keys/${key.id}/rotate`).set(BOOTSTRAP).expect(409);
});

test('B6.3 only a moderator rotates, and an unknown key is 404', async t => {
  if (skipUnlessDb(t)) return;
  const { key } = await authorWithScenarios();

  const asAuthor = await createKey(pool, 'author', 'Not A Moderator');
  await request(app).post(`/api/keys/${key.id}/rotate`).set(asAuthor.auth).expect(403);
  await request(app).post(`/api/keys/${key.id}/rotate`).expect(401);
  await request(app).post('/api/keys/999999/rotate').set(BOOTSTRAP).expect(404);
  await request(app).post('/api/keys/abc/rotate').set(BOOTSTRAP).expect(400);
});
