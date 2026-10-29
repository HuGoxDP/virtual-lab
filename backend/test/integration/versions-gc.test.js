// backend/test/integration/versions-gc.test.js
//
// Test-plan scenario 193 (DW-3.7): GC keeps every object a scenario or any version
// (current, pending, archived) references; a deleted version's object becomes collectible
// under the existing mtime / GC_MIN_AGE_MS rule; a dedup re-upload refreshes the object's mtime.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const request = require('supertest');

const { archiveN, sha256Of, removeArchiveRoot } = require('../helpers/app-env');
const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { createKey } = require('../helpers/keys');

let available = false;
const keys = {};

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
  keys.author = await createKey(pool, 'author', 'Alice');
  keys.moderator = await createKey(pool, 'moderator', 'Mia');
});

test.beforeEach(() => {
  failedAuth.reset();
  authorUploads.reset();
});

test.after(async () => {
  if (available) await truncateAll(pool);
  await pool.end();
  await removeArchiveRoot();
});

function skipUnlessDb(t) {
  if (!available) {
    t.skip('no database reachable — set DB_HOST/DB_NAME to run integration tests');
    return true;
  }
  return false;
}

const TWO_HOURS = 2 * 60 * 60 * 1000;
const exists = sha => fsp.access(storage.objectPath(sha)).then(() => true, () => false);

/** Makes an object look old enough to be swept (the default GC_MIN_AGE_MS is an hour). */
async function age(sha) {
  const then = new Date(Date.now() - TWO_HOURS);
  await fsp.utimes(storage.objectPath(sha), then, then);
}

let counter = 0;
async function makeScenario(status, owner = keys.author) {
  const id = `gc-${++counter}`;
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id)
    VALUES ($1, 'T', 'biology', 'Біологія', $2, $3)`, [id, status, owner.id]);
  return id;
}

const upload = (id, as, n) => request(app).post(`/api/scenarios/${id}/archive`).set(keys[as].auth)
  .attach('archive', archiveN(n), 'a.zip');
const gc = body => request(app).post('/api/admin/storage/gc').set(keys.moderator.auth).send(body);
const versionId = async (id, sha) => (await pool.query(
  'SELECT id FROM scenario_versions WHERE scenario_id = $1 AND sha256 = $2', [id, sha])).rows[0].id;

test('193. archived and pending objects survive a sweep; a deleted version\'s object does not (DW-3.7)', async t => {
  if (skipUnlessDb(t)) return;

  // A draft with three uploads (two end up archived) and a published one with an author's pending.
  const draft = await makeScenario('draft');
  for (const n of [1, 2, 3]) await upload(draft, 'moderator', n).expect(201);
  const live = await makeScenario('published');
  await upload(live, 'moderator', 4).expect(201);
  await upload(live, 'author', 5).expect(201);
  const [a1, a2, current, published, pending] = [1, 2, 3, 4, 5].map(n => sha256Of(archiveN(n)));
  const all = [a1, a2, current, published, pending];
  for (const sha of all) await age(sha);

  await t.test('only the current objects are in a scenario row; the rest are version-only references', async () => {
    const rows = (await pool.query('SELECT archive_sha256 FROM scenarios WHERE id = ANY($1)', [[draft, live]])).rows;
    assert.deepEqual(rows.map(r => r.archive_sha256).sort(), [current, published].sort());
  });

  await t.test('a dry run and a real sweep delete none of them, however old', async () => {
    const dry = await gc({}).expect(200);
    assert.equal(dry.body.wouldDelete.count, 0);
    const real = await gc({ dryRun: false }).expect(200);
    assert.equal(real.body.deleted.count, 0);
    for (const sha of all) assert.ok(await exists(sha), sha);
  });

  await t.test('the storage report counts them as referenced', async () => {
    const res = await request(app).get('/api/admin/storage').set(keys.moderator.auth).expect(200);
    assert.ok(res.body.referenced.count >= 5);
    assert.equal(res.body.orphans.count, 0);
  });

  await t.test('deleting an archived version makes only its object collectible (it is old enough)', async () => {
    await request(app).delete(`/api/scenarios/${draft}/versions/${await versionId(draft, a1)}`).set(keys.moderator.auth).expect(200);
    const dry = await gc({}).expect(200);
    assert.equal(dry.body.wouldDelete.count, 1);
    assert.ok(await exists(a1), 'a dry run deletes nothing');

    await gc({ dryRun: false }).expect(200);
    assert.equal(await exists(a1), false);
    for (const sha of [a2, current, published, pending]) assert.ok(await exists(sha), sha);
  });

  await t.test('rejecting a pending version (row deleted) frees its object the same way', async () => {
    await request(app).post(`/api/scenarios/${live}/versions/${await versionId(live, pending)}/reject`).set(keys.moderator.auth).expect(200);
    await gc({ dryRun: false }).expect(200);
    assert.equal(await exists(pending), false);
    assert.ok(await exists(published));
  });

  await t.test('a freshly deleted version\'s object is still protected by age', async () => {
    const fresh = sha256Of(archiveN(6));
    await upload(draft, 'moderator', 6).expect(201);            // a1 is gone; 2 and 3 archived, 6 current
    await upload(draft, 'moderator', 7).expect(201);            // 6 archived
    await request(app).delete(`/api/scenarios/${draft}/versions/${await versionId(draft, fresh)}`).set(keys.moderator.auth).expect(200);
    const res = await gc({}).expect(200);
    assert.equal(res.body.wouldDelete.count, 0);
    assert.equal(res.body.protectedByAge.count, 1);
    assert.ok(await exists(fresh));
  });

  await t.test('deleting the scenario frees every object only it referenced', async () => {
    await request(app).delete(`/api/catalog/${live}`).set(keys.moderator.auth).expect(200);
    assert.equal((await pool.query('SELECT 1 FROM scenario_versions WHERE scenario_id = $1', [live])).rowCount, 0);
    const dry = await gc({}).expect(200);
    assert.equal(dry.body.wouldDelete.count, 1, 'the published scenario\'s object (the pending one is already gone)');
  });
});

test('193. an object two scenarios share is kept until the last reference goes (DW-3.7)', async t => {
  if (skipUnlessDb(t)) return;
  await gc({ dryRun: false }).expect(200); // start from a swept store: earlier tests leave collectible objects
  const a = await makeScenario('draft');
  const b = await makeScenario('draft');
  await upload(a, 'moderator', 20).expect(201);
  await upload(b, 'moderator', 20).expect(201);
  const sha = sha256Of(archiveN(20));
  await age(sha);

  await request(app).delete(`/api/catalog/${a}`).set(keys.moderator.auth).expect(200);
  assert.equal((await gc({}).expect(200)).body.wouldDelete.count, 0, 'b still points at it');

  await request(app).delete(`/api/catalog/${b}`).set(keys.moderator.auth).expect(200);
  assert.equal((await gc({}).expect(200)).body.wouldDelete.count, 1);
});

test('193. a dedup re-upload refreshes the object\'s mtime, so GC cannot race it (DW-3.7)', async t => {
  if (skipUnlessDb(t)) return;
  await gc({ dryRun: false }).expect(200);
  const id = await makeScenario('draft');
  await upload(id, 'moderator', 30).expect(201);
  await upload(id, 'moderator', 31).expect(201);
  const first = sha256Of(archiveN(30));
  await request(app).delete(`/api/scenarios/${id}/versions/${await versionId(id, first)}`).set(keys.moderator.auth).expect(200);
  await age(first);
  assert.equal((await gc({}).expect(200)).body.wouldDelete.count, 1, 'collectible before the re-upload');

  const other = await makeScenario('draft');
  const started = Date.now();
  await upload(other, 'moderator', 30).expect(201); // the same bytes again: dedup

  const { mtimeMs } = await fsp.stat(storage.objectPath(first));
  assert.ok(mtimeMs >= started - 2000, 'the object is young again');
  assert.equal((await gc({}).expect(200)).body.wouldDelete.count, 0);
});
