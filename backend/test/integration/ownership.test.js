// backend/test/integration/ownership.test.js
//
// B6 phase 3 (DW-3.3): a moderator hands a scenario to another key; an author
// cannot give their work away and cannot take it. A revoked or unknown target
// is a refusal that changes nothing, and null means "moderators only".

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, addCurrentVersion } = require('../helpers/db');
const { createKey, revokeKey } = require('../helpers/keys');

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

async function scenarioOwnedBy(key) {
  const { rows } = await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, $2, '', 'bio', 'Біологія', 'draft', $3) RETURNING id`,
    [`own-${key.id}-${Math.random().toString(36).slice(2, 6)}`, 'Own It', key.id]
  );
  return rows[0].id;
}

test('B6.3 DW-3.3: transfer moves the owner, and only the new one can edit', async t => {
  if (skipUnlessDb(t)) return;

  const alice = await createKey(pool, 'author', 'Alice');
  const bob = await createKey(pool, 'author', 'Bob');
  const id = await scenarioOwnedBy(alice);

  await t.test('before: Alice edits, Bob is 403', async () => {
    await request(app).put(`/api/catalog/${id}`).set(alice.auth).send({ title: 'Alice was here' }).expect(200);
    await request(app).put(`/api/catalog/${id}`).set(bob.auth).send({ title: 'Bob' }).expect(403);
  });

  const res = await request(app).put(`/api/scenarios/${id}/owner`).set(BOOTSTRAP).send({ keyId: bob.id }).expect(200);

  await t.test('the answer is the new owner', () => {
    assert.deepEqual(res.body, { id, ownerKeyId: bob.id });
  });

  await t.test('after: Bob edits, Alice is 403', async () => {
    await request(app).put(`/api/catalog/${id}`).set(bob.auth).send({ title: 'Bob was here' }).expect(200);
    await request(app).put(`/api/catalog/${id}`).set(alice.auth).send({ title: 'Alice again' }).expect(403);
  });

  await t.test('one audit row names both', async () => {
    const { rows } = await pool.query("SELECT details FROM audit_events WHERE action = 'scenario.owner'");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].details, { from: alice.id, to: bob.id });
  });
});

test('B6.3 DW-3.3: a revoked or unknown target is a 400 that changes nothing', async t => {
  if (skipUnlessDb(t)) return;
  const alice = await createKey(pool, 'author', 'Alice2');
  const id = await scenarioOwnedBy(alice);

  const revoked = await createKey(pool, 'author', 'Revoked');
  await revokeKey(pool, revoked.id);
  const bad = await request(app).put(`/api/scenarios/${id}/owner`).set(BOOTSTRAP).send({ keyId: revoked.id }).expect(400);
  assert.match(bad.body.error, /відкликаний|не знайдено/);

  await request(app).put(`/api/scenarios/${id}/owner`).set(BOOTSTRAP).send({ keyId: 999999 }).expect(400);
  await request(app).put(`/api/scenarios/${id}/owner`).set(BOOTSTRAP).send({ keyId: 'x' }).expect(400);
  await request(app).put(`/api/scenarios/${id}/owner`).set(BOOTSTRAP).send({}).expect(400);
  await request(app).put('/api/scenarios/999999/owner').set(BOOTSTRAP).send({ keyId: revoked.id }).expect(404);

  const { rows } = await pool.query('SELECT owner_key_id FROM scenarios WHERE id = $1', [id]);
  assert.equal(rows[0].owner_key_id, alice.id, 'nothing moved');
});

test('B6.3 DW-3.3: only a moderator transfers', async t => {
  if (skipUnlessDb(t)) return;
  const alice = await createKey(pool, 'author', 'Alice3');
  const bob = await createKey(pool, 'author', 'Bob3');
  const id = await scenarioOwnedBy(alice);

  await request(app).put(`/api/scenarios/${id}/owner`).set(alice.auth).send({ keyId: bob.id }).expect(403);
  await request(app).put(`/api/scenarios/${id}/owner`).expect(401);
});

test('B6.3 DW-3.3: null hands the scenario to nobody — moderators only', async t => {
  if (skipUnlessDb(t)) return;
  const alice = await createKey(pool, 'author', 'Alice4');
  const id = await scenarioOwnedBy(alice);

  const res = await request(app).put(`/api/scenarios/${id}/owner`).set(BOOTSTRAP).send({ keyId: null }).expect(200);
  assert.equal(res.body.ownerKeyId, null);

  await t.test('an author is 403, a moderator still edits', async () => {
    await request(app).put(`/api/catalog/${id}`).set(alice.auth).send({ title: 'no' }).expect(403);
    await request(app).put(`/api/catalog/${id}`).set(BOOTSTRAP).send({ title: 'mod works' }).expect(200);
  });
});

test('B6.3 transferring to the current owner is a 409', async t => {
  if (skipUnlessDb(t)) return;
  const alice = await createKey(pool, 'author', 'Alice5');
  const id = await scenarioOwnedBy(alice);
  await request(app).put(`/api/scenarios/${id}/owner`).set(BOOTSTRAP).send({ keyId: alice.id }).expect(409);
});
