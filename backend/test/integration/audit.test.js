// backend/test/integration/audit.test.js
//
// Test-plan scenario 182 (DW-2.5): one `audit_events` row per authenticated
// mutation, written inside the request's own transaction; none for reads,
// telemetry, dry runs or refused requests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

// storage.js reads ARCHIVE_ROOT at load, so it is set before server.js is required.
const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-itest-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const { app, pool } = require('../../server');
const { inTransaction } = require('../../db');
const audit = require('../../audit');
const storage = require('../../storage');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { validArchive } = require('../helpers/fixtures');
const { createKey } = require('../helpers/keys');

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

let available = false;
let alice, mia;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
  alice = await createKey(pool, 'author', 'Alice');
  mia = await createKey(pool, 'moderator', 'Mia');
});

test.beforeEach(async () => {
  failedAuth.reset();
  authorUploads.reset();
  if (available) await pool.query('TRUNCATE audit_events');
});

test.after(async () => {
  if (available) await truncateAll(pool);
  await pool.end();
  await fsp.rm(ARCHIVE_ROOT, { recursive: true, force: true });
});

function skipUnlessDb(t) {
  if (!available) {
    t.skip('no database reachable — set DB_HOST/DB_NAME to run integration tests');
    return true;
  }
  return false;
}

const resetEvents = () => pool.query('TRUNCATE audit_events');
const events = async () => (await pool.query('SELECT * FROM audit_events ORDER BY id')).rows;

test('182. each authenticated mutation writes exactly one event (DW-2.5)', async t => {
  if (skipUnlessDb(t)) return;
  t.beforeEach(resetEvents);

  await t.test('POST /api/catalog by the bootstrap -> scenario.create, no key id', async () => {
    await request(app).post('/api/catalog').set(BOOTSTRAP)
      .send({ id: 'au-1', title: 'T', category: 'biology', categoryLabel: 'Біологія' }).expect(201);
    const [event, ...rest] = await events();
    assert.equal(rest.length, 0);
    assert.equal(event.action, 'scenario.create');
    assert.equal(event.scenario_id, 'au-1');
    assert.equal(event.actor_label, 'bootstrap');
    assert.equal(event.actor_key_id, null);
  });

  await t.test('PUT by an author -> scenario.update naming the fields, attributed to the key', async () => {
    await request(app).post('/api/catalog').set(alice.auth).send({ id: 'au-2', title: 'T', category: 'biology' }).expect(201);
    await resetEvents();
    await request(app).put('/api/catalog/au-2').set(alice.auth).send({ title: 'New', version: '2.0.0' }).expect(200);
    const [event, ...rest] = await events();
    assert.equal(rest.length, 0);
    assert.equal(event.action, 'scenario.update');
    assert.equal(event.scenario_id, 'au-2');
    assert.equal(event.actor_key_id, alice.id);
    assert.equal(event.actor_label, 'Alice');
    assert.deepEqual(event.details, { fields: ['title', 'version'] });
  });

  await t.test('DELETE -> scenario.delete, and the history outlives the scenario (no foreign key)', async () => {
    await request(app).delete('/api/catalog/au-2').set(mia.auth).expect(200);
    const rows = await events();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'scenario.delete');
    assert.equal(rows[0].scenario_id, 'au-2');
    assert.equal(rows[0].actor_label, 'Mia');
    const gone = await pool.query("SELECT 1 FROM scenarios WHERE id = 'au-2'");
    assert.equal(gone.rowCount, 0);
  });

  await t.test('archive upload -> scenario.archive with the hash', async () => {
    await request(app).post('/api/scenarios/au-1/archive').set(BOOTSTRAP)
      .attach('archive', validArchive(), 'scenario.zip').expect(201);
    const rows = await events();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'scenario.archive');
    assert.match(rows[0].details.sha256, /^[0-9a-f]{64}$/);
  });

  await t.test('key issue and revoke -> key.create / key.revoke with no scenario', async () => {
    const made = await request(app).post('/api/keys').set(BOOTSTRAP).send({ label: 'K', role: 'author' }).expect(201);
    await request(app).post(`/api/keys/${made.body.id}/revoke`).set(BOOTSTRAP).expect(200);
    const rows = await events();
    assert.deepEqual(rows.map(r => r.action), ['key.create', 'key.revoke']);
    assert.ok(rows.every(r => r.scenario_id === null));
  });

  await t.test('a storage sweep is journalled, its dry run is not', async () => {
    await request(app).post('/api/admin/storage/gc').set(BOOTSTRAP).send({}).expect(200);
    assert.equal((await events()).length, 0);
    await request(app).post('/api/admin/storage/gc').set(BOOTSTRAP).send({ dryRun: false }).expect(200);
    const rows = await events();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'storage.gc');
  });
});

test('182. reads, telemetry and refused requests write nothing (DW-2.5)', async t => {
  if (skipUnlessDb(t)) return;
  t.beforeEach(resetEvents);

  const reads = [
    () => request(app).get('/api/catalog'),
    () => request(app).get('/api/catalog/solar-system'),
    () => request(app).get('/api/auth/me').set(alice.auth),
    () => request(app).get('/api/admin/scenarios').set(alice.auth),
    () => request(app).get('/api/keys').set(mia.auth),
    () => request(app).get('/api/admin/storage').set(mia.auth),
    () => request(app).get('/api/telemetry/summary').set(mia.auth),
    () => request(app).post('/api/telemetry/session').send({ scenarioId: 'solar-system' }),
  ];
  for (const read of reads) await read();
  assert.equal((await events()).length, 0, 'a read or telemetry call wrote an event');

  await t.test('4xx outcomes: forbidden, missing, conflicting, invalid, anonymous', async () => {
    await request(app).put('/api/catalog/solar-system').set(alice.auth).send({ title: 'x' }).expect(403);
    await request(app).put('/api/catalog/does-not-exist').set(mia.auth).send({ title: 'x' }).expect(404);
    await request(app).delete('/api/catalog/does-not-exist').set(mia.auth).expect(404);
    await request(app).post('/api/catalog').set(mia.auth)
      .send({ id: 'solar-system', title: 'dup', category: 'astronomy', categoryLabel: 'x' }).expect(409);
    await request(app).post('/api/catalog').set(alice.auth).send({ id: 'x', title: 't', category: 'nope' }).expect(400);
    await request(app).post('/api/keys').set(mia.auth).send({ label: '', role: 'author' }).expect(400);
    await request(app).post('/api/keys/999999/revoke').set(mia.auth).expect(404);
    await request(app).post('/api/catalog').send({ id: 'x' }).expect(401);
    assert.equal((await events()).length, 0);
  });
});

test('182. an event rolls back with its transaction (DW-2.5)', async t => {
  if (skipUnlessDb(t)) return;
  t.beforeEach(resetEvents);

  await t.test('inTransaction: record then fail -> no row', async () => {
    await assert.rejects(inTransaction(async db => {
      await audit.record(db, { keyId: null, label: 'bootstrap' }, 'test.action', 'x', { a: 1 });
      throw new Error('boom');
    }), /boom/);
    assert.equal((await events()).length, 0);
  });

  await t.test('inTransaction: record then commit -> the row, with the actor and details', async () => {
    await inTransaction(db => audit.record(db, { keyId: alice.id, label: 'Alice' }, 'test.action', 's1', { a: 1 }));
    const [event] = await events();
    assert.deepEqual(
      { id: typeof event.id, key: event.actor_key_id, label: event.actor_label, action: event.action, scenario: event.scenario_id, details: event.details },
      { id: 'string', key: alice.id, label: 'Alice', action: 'test.action', scenario: 's1', details: { a: 1 } }
    );
  });

  // The route-level proof: the real insert runs, then the request's transaction
  // fails; neither the event nor the change may remain.
  const realRecord = audit.record;
  const failAfterRecord = async (...args) => {
    await realRecord(...args);
    throw new Error('audit failure after the insert');
  };

  await t.test('POST /api/catalog whose audit step fails -> 500, no scenario and no event', async () => {
    audit.record = failAfterRecord;
    try {
      await request(app).post('/api/catalog').set(BOOTSTRAP)
        .send({ id: 'au-rb', title: 'T', category: 'biology', categoryLabel: 'Біологія' }).expect(500);
    } finally {
      audit.record = realRecord;
    }
    assert.equal((await pool.query("SELECT 1 FROM scenarios WHERE id = 'au-rb'")).rowCount, 0);
    assert.equal((await events()).length, 0);
  });

  await t.test('PUT, DELETE and archive whose audit step fails leave the data untouched', async () => {
    const before = (await pool.query("SELECT title, archive_sha256 FROM scenarios WHERE id = 'solar-system'")).rows[0];
    audit.record = failAfterRecord;
    try {
      await request(app).put('/api/catalog/solar-system').set(BOOTSTRAP).send({ title: 'Changed' }).expect(500);
      await request(app).delete('/api/catalog/solar-system').set(BOOTSTRAP).expect(500);
      await request(app).post('/api/scenarios/solar-system/archive').set(BOOTSTRAP)
        .attach('archive', validArchive(), 'scenario.zip').expect(500);
    } finally {
      audit.record = realRecord;
    }
    const after = (await pool.query("SELECT title, archive_sha256 FROM scenarios WHERE id = 'solar-system'")).rows[0];
    assert.deepEqual(after, before);
    assert.equal((await events()).length, 0);
  });

  await t.test('a key issue whose audit step fails -> no key is left behind', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM publish_keys')).rows[0].n;
    audit.record = failAfterRecord;
    try {
      await request(app).post('/api/keys').set(BOOTSTRAP).send({ label: 'ghost', role: 'author' }).expect(500);
    } finally {
      audit.record = realRecord;
    }
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM publish_keys')).rows[0].n, before);
  });
});
