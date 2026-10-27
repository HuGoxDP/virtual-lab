// backend/test/integration/rate-limits.test.js
//
// Test-plan scenario 183 (DW-2.6): failed authentication is limited per address
// (30 per 15 minutes, successes never counted, valid keys never limited) and
// author uploads per key (20 per hour, moderators and the bootstrap exempt);
// `last_used_at` moves when a key is used.

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
const storage = require('../../storage');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { validArchive } = require('../helpers/fixtures');
const { createKey } = require('../helpers/keys');

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

let available = false;
let alice, bob, mia;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
  alice = await createKey(pool, 'author', 'Alice');
  bob = await createKey(pool, 'author', 'Bob');
  mia = await createKey(pool, 'moderator', 'Mia');
  for (const [id, owner] of [['rl-alice', alice.id], ['rl-bob', bob.id], ['rl-mia', mia.id]]) {
    await pool.query(`
      INSERT INTO scenarios (id, title, category, category_label, is_published, owner_key_id)
      VALUES ($1, 'T', 'biology', 'Біологія', false, $2)`, [id, owner]);
  }
});

test.beforeEach(() => {
  failedAuth.reset();
  authorUploads.reset();
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

/** `ip` is the address nginx would forward (the app trusts one proxy hop). */
const failAt = ip => request(app).get('/api/auth/me').set('X-Forwarded-For', ip).set('Authorization', 'Bearer wrong');
const goodAt = (ip, as) => request(app).get('/api/auth/me').set('X-Forwarded-For', ip).set(as.auth ?? as);
const upload = (id, as) => request(app).post(`/api/scenarios/${id}/archive`).set(as.auth ?? as)
  .attach('archive', validArchive(), 'scenario.zip');

test('183. failed authentication is limited per address (DW-2.6)', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('failures 29 and 30 are 403, the 31st is 429 with Retry-After', async () => {
    const statuses = [];
    let last;
    for (let i = 0; i < 31; i++) {
      last = await failAt('203.0.113.1');
      statuses.push(last.status);
    }
    assert.deepEqual([statuses[28], statuses[29], statuses[30]], [403, 403, 429]);
    assert.ok(statuses.slice(0, 30).every(s => s === 403));
    assert.ok(Number(last.headers['retry-after']) > 0);
    assert.match(last.body.error, /Забагато/);
  });

  await t.test('a valid key is never limited, even from an exhausted address', async () => {
    for (let i = 0; i < 31; i++) await failAt('203.0.113.2');
    await failAt('203.0.113.2').expect(429);
    await goodAt('203.0.113.2', alice).expect(200);
    await goodAt('203.0.113.2', { Authorization: BOOTSTRAP.Authorization }).expect(200);
  });

  await t.test('another address is unaffected', async () => {
    for (let i = 0; i < 31; i++) await failAt('203.0.113.3');
    await failAt('203.0.113.4').expect(403);
  });

  await t.test('successes do not count: 40 good calls leave all 30 failures available', async () => {
    for (let i = 0; i < 40; i++) await goodAt('203.0.113.5', alice).expect(200);
    for (let i = 0; i < 30; i++) await failAt('203.0.113.5').expect(403);
    await failAt('203.0.113.5').expect(429);
  });

  await t.test('presenting nothing does not count either', async () => {
    for (let i = 0; i < 40; i++) {
      await request(app).get('/api/auth/me').set('X-Forwarded-For', '203.0.113.6').expect(401);
    }
    await failAt('203.0.113.6').expect(403);
  });

  await t.test('a revoked key counts as a failure', async () => {
    const gone = await createKey(pool, 'author', 'Gone');
    await pool.query('UPDATE publish_keys SET revoked_at = NOW() WHERE id = $1', [gone.id]);
    for (let i = 0; i < 30; i++) await goodAt('203.0.113.7', gone).expect(403);
    await goodAt('203.0.113.7', gone).expect(429);
  });
});

test('183. author uploads are limited per key (DW-2.6)', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('an author key: uploads 1-20 succeed, the 21st is 429 with Retry-After', async () => {
    for (let i = 1; i <= 20; i++) await upload('rl-alice', alice).expect(201);
    const over = await upload('rl-alice', alice).expect(429);
    assert.ok(Number(over.headers['retry-after']) > 0);
  });

  await t.test('the limit is per key: another author is unaffected, and so are reads', async () => {
    await upload('rl-bob', bob).expect(201);
    await request(app).get('/api/admin/scenarios').set(alice.auth).expect(200);
  });

  await t.test('a moderator key and the bootstrap are exempt (21st upload -> 201)', async () => {
    for (let i = 1; i <= 21; i++) await upload('rl-mia', mia).expect(201);
    for (let i = 1; i <= 21; i++) await upload('rl-mia', BOOTSTRAP).expect(201);
  });

  await t.test('a refused upload (403) still uses a slot — the limit counts attempts', async () => {
    authorUploads.reset();
    for (let i = 1; i <= 20; i++) await upload('rl-bob', alice).expect(403);
    await upload('rl-alice', alice).expect(429);
  });

  await t.test('the limit does not touch other writes by the same author', async () => {
    for (let i = 1; i <= 21; i++) await upload('rl-alice', alice);
    await request(app).put('/api/catalog/rl-alice').set(alice.auth).send({ title: 'Still works' }).expect(200);
  });
});

test('183. last_used_at moves when a key is used (DW-2.6)', async t => {
  if (skipUnlessDb(t)) return;
  const key = await createKey(pool, 'author', 'Used');
  const lastUsed = async () => (await pool.query('SELECT last_used_at FROM publish_keys WHERE id = $1', [key.id])).rows[0].last_used_at;

  assert.equal(await lastUsed(), null, 'never used yet');
  await request(app).get('/api/auth/me').set(key.auth).expect(200);
  const first = await lastUsed();
  assert.ok(first instanceof Date);

  await new Promise(resolve => setTimeout(resolve, 20));
  await request(app).get('/api/admin/scenarios').set(key.auth).expect(200);
  assert.ok((await lastUsed()) > first, 'the second use moved it');

  await t.test('a failed attempt with a wrong token moves nothing', async () => {
    const before = await lastUsed();
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer wrong').expect(403);
    assert.deepEqual(await lastUsed(), before);
  });
});
