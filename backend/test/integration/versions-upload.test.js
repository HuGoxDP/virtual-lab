// backend/test/integration/versions-upload.test.js
//
// Test-plan scenario 189 (DW-3.3): an archive upload lands in the version history according
// to the scenario's status and the uploader's role; a pending archive leaves students on the
// old one until a moderator accepts it. Also the 50-version cap and the upload/approve race.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const request = require('supertest');

const { archiveN, sha256Of, removeArchiveRoot } = require('../helpers/app-env');
const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { MAX_VERSIONS } = require('../../versions');
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
  keys.owner = await createKey(pool, 'author', 'Alice');
  keys.other = await createKey(pool, 'author', 'Bob');
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

let counter = 0;

async function makeRow(status) {
  const id = `up-${++counter}`;
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id)
    VALUES ($1, 'T', 'biology', 'Біологія', $2, $3)`, [id, status, keys.owner.id]);
  return id;
}

const upload = (id, as, n) => request(app).post(`/api/scenarios/${id}/archive`).set(keys[as].auth)
  .attach('archive', archiveN(n), 'scenario.zip');

const versionsOf = async id => (await pool.query(
  'SELECT sha256, state FROM scenario_versions WHERE scenario_id = $1 ORDER BY id', [id])).rows;
const stateOf = async (id, state) => (await versionsOf(id)).filter(v => v.state === state).map(v => v.sha256);
const rowOf = async id => (await pool.query('SELECT * FROM scenarios WHERE id = $1', [id])).rows[0];
const objectCount = async () => (await fsp.readdir(storage.OBJECTS_DIR)).length;
const noTempFiles = async () => assert.deepEqual(await fsp.readdir(storage.TMP_DIR), []);

for (const status of ['draft', 'rejected']) {
  test(`189. upload into a ${status} scenario: a new current version (DW-3.3)`, async t => {
    if (skipUnlessDb(t)) return;
    const id = await makeRow(status);

    await t.test('the first upload becomes current and the row points at it', async () => {
      const res = await upload(id, 'owner', 1).expect(201);
      assert.equal(res.body.version.state, 'current');
      assert.equal(res.body.sha256, sha256Of(archiveN(1)));
      assert.equal(res.body.url, `/scenarios/${sha256Of(archiveN(1))}.zip`);
      const row = await rowOf(id);
      assert.equal(row.archive_sha256, sha256Of(archiveN(1)));
      assert.equal(row.scenario_url, res.body.url);
      assert.equal(row.status, status, 'an upload never moves the status');
    });

    await t.test('the second upload becomes current, the first is archived', async () => {
      await upload(id, 'owner', 2).expect(201);
      assert.deepEqual(await stateOf(id, 'current'), [sha256Of(archiveN(2))]);
      assert.deepEqual(await stateOf(id, 'archived'), [sha256Of(archiveN(1))]);
      assert.equal((await rowOf(id)).archive_sha256, sha256Of(archiveN(2)));
    });

    await t.test('a pending row left over (from before an unpublish) is deleted by the upload', async () => {
      await pool.query(
        "INSERT INTO scenario_versions (scenario_id, sha256, bytes, state) VALUES ($1, $2, 1, 'pending')", [id, 'f'.repeat(64)]);
      await upload(id, 'owner', 3).expect(201);
      assert.deepEqual(await stateOf(id, 'pending'), []);
      assert.deepEqual(await stateOf(id, 'current'), [sha256Of(archiveN(3))]);
    });

    await t.test('identical bytes to the current version change nothing', async () => {
      const before = await versionsOf(id);
      const res = await upload(id, 'owner', 3).expect(201);
      assert.equal(res.body.deduplicated, true);
      assert.equal(res.body.version.state, 'current');
      assert.deepEqual(await versionsOf(id), before);
    });
  });
}

test('189. upload into a scenario in review -> 409, from the owner and from a moderator (DW-3.3)', async t => {
  if (skipUnlessDb(t)) return;
  const id = await makeRow('review');
  const objectsBefore = await objectCount();

  for (const as of ['owner', 'moderator']) {
    await t.test(`as ${as}`, async () => {
      const res = await upload(id, as, 10).expect(409);
      assert.match(res.body.error, /відкличте/i);
      assert.deepEqual(await versionsOf(id), []);
      assert.equal(await objectCount(), objectsBefore, 'nothing entered the store');
      await noTempFiles();
    });
  }

  await t.test('after a withdraw the same upload succeeds', async () => {
    await request(app).post(`/api/scenarios/${id}/withdraw`).set(keys.owner.auth).expect(200);
    await upload(id, 'owner', 10).expect(201);
  });
});

test('189. upload into a published scenario: moderator -> current, author -> pending (DW-3.3)', async t => {
  if (skipUnlessDb(t)) return;
  const id = await makeRow('published');
  await upload(id, 'moderator', 20).expect(201);
  const live = sha256Of(archiveN(20));
  const liveUrl = `/scenarios/${live}.zip`;
  const publicUrl = async () => (await request(app).get(`/api/catalog/${id}`).expect(200)).body.scenarioUrl;

  await t.test('a moderator\'s upload is current at once and students get it', async () => {
    assert.deepEqual(await stateOf(id, 'current'), [live]);
    assert.equal(await publicUrl(), liveUrl);
  });

  await t.test('an author\'s upload is pending; the row and the catalog keep the old archive', async () => {
    const res = await upload(id, 'owner', 21).expect(201);
    assert.equal(res.body.version.state, 'pending');
    assert.deepEqual(await stateOf(id, 'pending'), [sha256Of(archiveN(21))]);
    assert.deepEqual(await stateOf(id, 'current'), [live]);
    assert.equal((await rowOf(id)).archive_sha256, live);
    assert.equal(await publicUrl(), liveUrl, 'students stay on the old archive until accept');
  });

  await t.test('a second author upload replaces the pending one; its row is deleted, not archived', async () => {
    await upload(id, 'owner', 22).expect(201);
    assert.deepEqual(await stateOf(id, 'pending'), [sha256Of(archiveN(22))]);
    assert.equal((await versionsOf(id)).length, 2, 'current + the one pending');
    assert.equal(await publicUrl(), liveUrl);
  });

  await t.test('the same bytes as the current version are not a pending proposal', async () => {
    const res = await upload(id, 'owner', 20).expect(201);
    assert.equal(res.body.version.state, 'current');
    assert.deepEqual(await stateOf(id, 'pending'), [sha256Of(archiveN(22))], 'the earlier proposal is untouched');
  });

  await t.test('a moderator\'s upload to a published scenario leaves the author\'s pending proposal alone', async () => {
    await upload(id, 'moderator', 23).expect(201);
    assert.deepEqual(await stateOf(id, 'current'), [sha256Of(archiveN(23))]);
    assert.deepEqual(await stateOf(id, 'pending'), [sha256Of(archiveN(22))]);
    assert.deepEqual(await stateOf(id, 'archived'), [live]);
  });

  await t.test('accepting the pending version is what moves students', async () => {
    const pendingId = (await pool.query("SELECT id FROM scenario_versions WHERE scenario_id = $1 AND state = 'pending'", [id])).rows[0].id;
    await request(app).post(`/api/scenarios/${id}/versions/${pendingId}/accept`).set(keys.moderator.auth).expect(200);
    assert.equal(await publicUrl(), `/scenarios/${sha256Of(archiveN(22))}.zip`);
  });
});

test('189. a stranger or an unknown scenario cannot upload; nothing is stored (DW-3.3)', async t => {
  if (skipUnlessDb(t)) return;
  const id = await makeRow('draft');
  const objectsBefore = await objectCount();

  await upload(id, 'other', 30).expect(403);
  await upload('up-nope', 'owner', 30).expect(404);
  assert.equal(await objectCount(), objectsBefore);
  await noTempFiles();
});

test('189. more than 50 versions -> 409 and the store is untouched (DW-3.3)', async t => {
  if (skipUnlessDb(t)) return;
  const id = await makeRow('draft');
  await pool.query(`
    INSERT INTO scenario_versions (scenario_id, sha256, bytes, state)
    SELECT $1, lpad(g::text, 64, '0'), 1, CASE WHEN g = 1 THEN 'current' ELSE 'archived' END
      FROM generate_series(1, ${MAX_VERSIONS}) g`, [id]);

  await t.test(`the ${MAX_VERSIONS}th version exists, the 51st is refused`, async () => {
    const res = await upload(id, 'owner', 40).expect(409);
    assert.match(res.body.error, new RegExp(String(MAX_VERSIONS)));
    assert.equal((await versionsOf(id)).length, MAX_VERSIONS);
    assert.equal((await rowOf(id)).archive_sha256, null);
    await noTempFiles();
  });

  await t.test('a moderator is held to the same cap', async () => {
    await upload(id, 'moderator', 41).expect(409);
  });

  await t.test('replacing a pending proposal is not growth: it works at the cap', async () => {
    const live = await makeRow('published');
    await pool.query(`
      INSERT INTO scenario_versions (scenario_id, sha256, bytes, state)
      SELECT $1, lpad(g::text, 64, '1'), 1, CASE WHEN g = 1 THEN 'current' WHEN g = 2 THEN 'pending' ELSE 'archived' END
        FROM generate_series(1, ${MAX_VERSIONS}) g`, [live]);
    await upload(live, 'owner', 42).expect(201);
    assert.equal((await versionsOf(live)).length, MAX_VERSIONS);
  });
});

test('189. an author\'s upload racing an approve never lands as current on the published row (DW-3.3)', async t => {
  if (skipUnlessDb(t)) return;

  for (const round of [1, 2, 3, 4, 5]) {
    await t.test(`round ${round}`, async () => {
      const id = await makeRow('draft');
      await upload(id, 'moderator', 50 + round * 10).expect(201); // the archive the approve needs
      const uploaded = sha256Of(archiveN(51 + round * 10));

      const [up, approve] = await Promise.all([
        request(app).post(`/api/scenarios/${id}/archive`).set(keys.owner.auth).attach('archive', archiveN(51 + round * 10), 'a.zip'),
        request(app).post(`/api/scenarios/${id}/approve`).set(keys.moderator.auth),
      ]);
      assert.equal(approve.status, 200);
      assert.equal(up.status, 201);

      const row = await rowOf(id);
      assert.equal(row.status, 'published');
      const current = await stateOf(id, 'current');
      assert.equal(current.length, 1);
      assert.equal(row.archive_sha256, current[0], 'the row mirrors its current version');

      if (up.body.version.state === 'pending') {
        assert.notEqual(row.archive_sha256, uploaded, 'a pending upload is not what students get');
      } else {
        assert.equal(row.archive_sha256, uploaded, 'it landed before the approve, so it is what was approved');
      }
    });
  }
});
