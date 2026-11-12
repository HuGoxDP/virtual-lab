// backend/test/integration/history-era.test.js
//
// B6 phase 4 (DW-4.2): a scenario id is not unique over time. A moderator deletes a row and an
// author creates the same id again; without the era filter the new owner reads the previous
// owner's history through their own id. A moderator keeps the full history (they administer the
// catalog), an author sees only the live row's era.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const { createKey } = require('../helpers/keys');

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

/** Inserts a scenario row with a distinct id, owned by `key`, and one audit event of its era. */
async function era(key, tag) {
  const id = `era-${tag}-${Math.random().toString(36).slice(2, 5)}`;
  await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, $2, '', 'bio', 'Біологія', 'draft', $3)`,
    [id, `Era ${tag}`, key.id]
  );
  await pool.query(
    `INSERT INTO audit_events (scenario_id, actor_key_id, actor_label, action, details)
     VALUES ($1, $2, $3, 'scenario.create', '{}')`,
    [id, key.id, key.label]
  );
  return id;
}

test('B6.4 DW-4.2: a new owner reads only the live row era; a moderator reads both', async t => {
  if (skipUnlessDb(t)) return;

  const alice = await createKey(pool, 'author', 'Alice');
  const bob = await createKey(pool, 'author', 'Bob');

  // Two eras that share a scenario id, as delete + recreate produces in production.
  const id = `shared-id-${Math.random().toString(36).slice(2, 5)}`;
  await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, 'Shared', '', 'bio', 'Біологія', 'draft', $2)`, [id, alice.id]
  );
  await pool.query(
    `INSERT INTO audit_events (scenario_id, actor_key_id, actor_label, action, details)
     VALUES ($1, $2, 'Alice', 'scenario.create', '{}')`, [id, alice.id]
  );
  // The journal survives a deletion by design (scenario_id is not a foreign key),
  // so delete only the row and leave Alice's events in place.
  await pool.query('DELETE FROM scenarios WHERE id = $1', [id]);
  await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, 'Shared', '', 'bio', 'Біологія', 'draft', $2)`, [id, bob.id]
  );
  await pool.query(
    `INSERT INTO audit_events (scenario_id, actor_key_id, actor_label, action, details)
     VALUES ($1, $2, 'Bob', 'scenario.create', '{}')`, [id, bob.id]
  );

  await t.test("the owner's history holds only the new era", async () => {
    const res = await request(app).get(`/api/scenarios/${id}/history`).set(bob.auth).expect(200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].actorLabel, 'Bob');
  });

  await t.test("the moderator's history holds both eras", async () => {
    const res = await request(app).get(`/api/scenarios/${id}/history`).set(BOOTSTRAP).expect(200);
    // Bob's row was created after Alice's event, so both eras are in the table.
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM audit_events WHERE scenario_id = $1', [id]);
    assert.equal(res.body.length, rows[0].n);
    assert.equal(rows[0].n, 2, 'both eras are in the journal');
    const labels = res.body.map(e => e.actorLabel).sort();
    assert.deepEqual(labels, ['Alice', 'Bob']);
  });

  await t.test("a dashboard for Bob's key shows only his own era", async () => {
    const res = await request(app).get('/api/admin/dashboard').set(bob.auth).expect(200);
    assert.deepEqual(res.body.activity.map(e => e.actorLabel), ['Bob']);
  });
});

// B6r1 (F-R3): a transfer. Alice authors a scenario, a moderator hands it to Bob, and from then
// on the scenario is Bob's — but its row keeps the `created_at` it was created with, so the era
// anchored to `scenarios.created_at` still let Bob read Alice's journal. The era now starts at
// the `scenario.owner` event naming him.
test('B6r1 F-R3: a transferred scenario starts its owner era at the hand-over', async t => {
  if (skipUnlessDb(t)) return;

  const alice = await createKey(pool, 'author', 'Alice');
  const bob = await createKey(pool, 'author', 'Bob');
  const id = `handed-${Math.random().toString(36).slice(2, 5)}`;

  // Alice authors it: her create, and a later update, both before the hand-over.
  const { rows: [row] } = await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, 'Handed', '', 'bio', 'Біологія', 'draft', $2) RETURNING created_at`, [id, alice.id]
  );
  await pool.query(
    `INSERT INTO audit_events (scenario_id, actor_key_id, actor_label, action, details)
     VALUES ($1, $2, 'Alice', 'scenario.create', '{}')`, [id, alice.id]
  );
  await pool.query(
    `INSERT INTO audit_events (scenario_id, actor_key_id, actor_label, action, details)
     VALUES ($1, $2, 'Alice', 'scenario.update', '{"changed":["title"]}')`, [id, alice.id]
  );
  assert.ok(new Date(row.created_at).getTime() > 0, 'the row keeps its original created_at');

  // The moderator hands it over — the route records `scenario.owner` with `to`.
  const transferred = await request(app)
    .put(`/api/scenarios/${id}/owner`)
    .set(BOOTSTRAP)
    .send({ keyId: bob.id })
    .expect(200);
  assert.equal(transferred.body.ownerKeyId, bob.id);

  await t.test("the new owner's history starts at the hand-over", async () => {
    const res = await request(app).get(`/api/scenarios/${id}/history`).set(bob.auth).expect(200);
    const labels = res.body.map(e => e.action);
    assert.ok(labels.includes('scenario.owner'), `the hand-over is in Bob's history: ${labels}`);
    assert.ok(!labels.includes('scenario.create'), `Alice's create is not: ${labels}`);
    assert.ok(!labels.includes('scenario.update'), `Alice's update is not: ${labels}`);
  });

  await t.test("the old owner no longer owns it, so reads nothing", async () => {
    await request(app).get(`/api/scenarios/${id}/history`).set(alice.auth).expect(403);
  });

  await t.test("the moderator still administers the whole journal", async () => {
    const res = await request(app).get(`/api/scenarios/${id}/history`).set(BOOTSTRAP).expect(200);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM audit_events WHERE scenario_id = $1', [id]);
    assert.equal(res.body.length, rows[0].n);
    assert.equal(rows[0].n, 3, "Alice's two events and the hand-over");
  });

  await t.test("the new owner's dashboard agrees", async () => {
    const res = await request(app).get('/api/admin/dashboard').set(bob.auth).expect(200);
    const actions = res.body.activity.map(e => e.action);
    assert.deepEqual(actions, ['scenario.owner']);
  });

  // A scenario nobody ever handed to Bob keeps the old anchor: the row's creation.
  const own = await era(bob, 'unhanded');
  await t.test("a scenario never transferred anchors on its own creation", async () => {
    const res = await request(app).get(`/api/scenarios/${own}/history`).set(bob.auth).expect(200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].action, 'scenario.create');
  });
});
