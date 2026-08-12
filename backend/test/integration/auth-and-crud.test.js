// backend/test/integration/auth-and-crud.test.js
//
// Covers test-plan scenarios 17–23 (auth) and 87 (publish round-trip),
// plus the admin listing.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');

const TOKEN = process.env.ADMIN_TOKEN;
const AUTH = { Authorization: `Bearer ${TOKEN}` };

let available = false;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
});

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

/** Every route that must never be reachable without the admin token. */
const GUARDED = [
  ['post', '/api/catalog'],
  ['put', '/api/catalog/solar-system'],
  ['delete', '/api/catalog/solar-system'],
  ['get', '/api/admin/scenarios'],
  ['get', '/api/telemetry/summary'],
  ['post', '/api/scenarios/solar-system/archive'],
  ['post', '/api/scenarios/solar-system/archive/import'],
];

test('admin routes reject anonymous callers', async t => {
  if (skipUnlessDb(t)) return;

  for (const [method, path] of GUARDED) {
    await t.test(`${method.toUpperCase()} ${path} → 401 without a header`, async () => {
      await request(app)[method](path).expect(401);
    });
  }
});

test('admin routes reject a wrong token', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('a token of the same length but different value → 403', async () => {
    const wrong = 'x'.repeat(TOKEN.length);
    await request(app).get('/api/admin/scenarios')
      .set('Authorization', `Bearer ${wrong}`)
      .expect(403);
  });

  await t.test('a token of a different length → 403, not a crash', async () => {
    // timingSafeEqual throws on length mismatch; the length guard must catch it.
    await request(app).get('/api/admin/scenarios')
      .set('Authorization', 'Bearer short')
      .expect(403);
  });

  await t.test('a prefix of the real token → 403', async () => {
    await request(app).get('/api/admin/scenarios')
      .set('Authorization', `Bearer ${TOKEN.slice(0, -1)}`)
      .expect(403);
  });

  await t.test('a header without the Bearer prefix → 401', async () => {
    await request(app).get('/api/admin/scenarios')
      .set('Authorization', TOKEN)
      .expect(401);
  });
});

test('public reads stay public', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('catalog list needs no header', async () => {
    await request(app).get('/api/catalog').expect(200);
  });

  await t.test('catalog detail needs no header', async () => {
    await request(app).get('/api/catalog/solar-system').expect(200);
  });

  await t.test('health needs no header', async () => {
    await request(app).get('/api/health').expect(200);
  });
});

test('GET /api/health reports the API build, not the engine build', async t => {
  if (skipUnlessDb(t)) return;

  const res = await request(app).get('/api/health').expect(200);

  await t.test('carries this service\'s own version', () => {
    assert.equal(res.body.build.version, require('../../package.json').version);
  });

  await t.test('reports uptime and a start time', () => {
    assert.ok(Number.isInteger(res.body.build.uptimeSeconds));
    assert.ok(!Number.isNaN(Date.parse(res.body.build.startedAt)));
  });

  await t.test('commit is null rather than a stale default when unset', () => {
    // Null is the honest answer for an image built from a working tree; a
    // placeholder string would be indistinguishable from a real commit.
    assert.equal(res.body.build.commit, process.env.API_COMMIT || null);
  });

  await t.test('says nothing about the engine', () => {
    // The engine build is a property of the bundle in the browser and only the
    // browser can read it (BuildInfo, shown in the viewer under ?diag=1).
    // Restating it here would drift the moment a tarball was installed without
    // a backend rebuild.
    assert.ok(!('engine' in res.body.build));
    assert.ok(!('engineVersion' in res.body.build));
  });
});

test('GET /api/admin/scenarios exposes what the catalog hides', async t => {
  if (skipUnlessDb(t)) return;

  const res = await request(app).get('/api/admin/scenarios').set(AUTH).expect(200);

  await t.test('includes unpublished rows', () => {
    const ids = res.body.scenarios.map(s => s.id);
    assert.ok(ids.includes('hidden-one'));
    assert.ok(ids.includes('drive-legacy'));
  });

  await t.test('surfaces the publish flag and storage state', () => {
    const hidden = res.body.scenarios.find(s => s.id === 'hidden-one');
    assert.equal(hidden.isPublished, false);
    assert.equal(hidden.storageKind, 'drive');
    assert.equal(hidden.manifestId, null);
  });
});

test('catalog CRUD', async t => {
  if (skipUnlessDb(t)) return;

  const id = 'crud-probe';

  await t.test('rejects a payload missing required fields', async () => {
    await request(app).post('/api/catalog').set(AUTH)
      .send({ id, title: 'no category' })
      .expect(400);
  });

  await t.test('creates a scenario', async () => {
    await request(app).post('/api/catalog').set(AUTH)
      .send({ id, title: 'Probe', category: 'test', categoryLabel: 'Test' })
      .expect(201);
  });

  await t.test('refuses a duplicate id with 409', async () => {
    await request(app).post('/api/catalog').set(AUTH)
      .send({ id, title: 'Probe again', category: 'test', categoryLabel: 'Test' })
      .expect(409);
  });

  await t.test('updates only the fields supplied', async () => {
    await request(app).put(`/api/catalog/${id}`).set(AUTH)
      .send({ title: 'Renamed' })
      .expect(200);

    const res = await request(app).get(`/api/catalog/${id}`).expect(200);
    assert.equal(res.body.title, 'Renamed');
    assert.equal(res.body.category, 'test', 'untouched fields must survive');
  });

  await t.test('rejects an update with no fields', async () => {
    await request(app).put(`/api/catalog/${id}`).set(AUTH).send({}).expect(400);
  });

  await t.test('404s an update to an unknown id', async () => {
    await request(app).put('/api/catalog/nope').set(AUTH).send({ title: 'x' }).expect(404);
  });

  await t.test('unpublishing removes it from the public catalog', async () => {
    await request(app).put(`/api/catalog/${id}`).set(AUTH)
      .send({ isPublished: false })
      .expect(200);

    await request(app).get(`/api/catalog/${id}`).expect(404);

    const admin = await request(app).get('/api/admin/scenarios').set(AUTH).expect(200);
    const row = admin.body.scenarios.find(s => s.id === id);
    assert.equal(row.isPublished, false, 'still visible to the admin');
  });

  await t.test('republishing brings it back', async () => {
    await request(app).put(`/api/catalog/${id}`).set(AUTH)
      .send({ isPublished: true })
      .expect(200);
    await request(app).get(`/api/catalog/${id}`).expect(200);
  });

  await t.test('deletes it', async () => {
    await request(app).delete(`/api/catalog/${id}`).set(AUTH).expect(200);
    await request(app).get(`/api/catalog/${id}`).expect(404);
  });

  await t.test('404s deleting a second time', async () => {
    await request(app).delete(`/api/catalog/${id}`).set(AUTH).expect(404);
  });
});
