// backend/test/integration/author-rules.test.js
//
// Test-plan scenario 181 (DW-2.4): what an author key may send and touch.
// Content fields of their own scenarios only; created rows are unpublished and
// owned; a category must already exist; an upload into a published scenario is
// refused. Moderators keep every power the bootstrap token had.

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
const { AUTHOR_FORBIDDEN_FIELDS } = require('../../catalog-input');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { validArchive } = require('../helpers/fixtures');
const { createKey } = require('../helpers/keys');

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

const row = async id => (await pool.query('SELECT * FROM scenarios WHERE id = $1', [id])).rows[0];
const categoryCount = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM categories')).rows[0].n;

async function insertOwned(id, owner, { published = false } = {}) {
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id)
    VALUES ($1, 'Title', 'biology', 'Біологія', $2, $3)
    ON CONFLICT (id) DO UPDATE SET status = $2, owner_key_id = $3, title = 'Title'
  `, [id, published ? 'published' : 'draft', owner]);
}

const newScenario = (id, extra = {}) => ({ id, title: 'T', category: 'biology', ...extra });

test('181. POST by an author (DW-2.4)', async t => {
  if (skipUnlessDb(t)) return;
  const categoriesBefore = await categoryCount();

  const res = await request(app).post('/api/catalog').set(alice.auth)
    .send(newScenario('ar-created', {
      categoryLabel: 'IGNORED LABEL', description: 'd', fullDescription: 'f', version: '2.0.0',
      features: [{ icon: 'atom', title: 'Atoms' }],
    }))
    .expect(201);

  await t.test('the row is unpublished, owned by the key, and authored by its label', async () => {
    const created = await row(res.body.id);
    assert.equal(created.status, 'draft');
    assert.equal(created.owner_key_id, alice.id);
    assert.equal(created.author, 'Alice');
    assert.equal(created.version, '2.0.0');
  });

  await t.test('categoryLabel is ignored: the category keeps its own label, no category is added', async () => {
    assert.equal((await row('ar-created')).category_label, 'Біологія');
    assert.equal(await categoryCount(), categoriesBefore);
    const { rows } = await pool.query("SELECT label FROM categories WHERE slug = 'biology'");
    assert.equal(rows[0].label, 'Біологія');
  });

  await t.test('it is not in the public catalog', async () => {
    await request(app).get('/api/catalog/ar-created').expect(404);
  });

  await t.test('categoryLabel is not required of an author', async () => {
    await request(app).post('/api/catalog').set(alice.auth).send(newScenario('ar-nolabel')).expect(201);
  });

  await t.test('missing id, title or category -> 400', async () => {
    for (const body of [{ title: 'T', category: 'biology' }, { id: 'x', category: 'biology' }, { id: 'x', title: 'T' }]) {
      await request(app).post('/api/catalog').set(alice.auth).send(body).expect(400);
    }
  });
});

test('181. forbidden fields are 400 for an author, on POST and on PUT (DW-2.4)', async t => {
  if (skipUnlessDb(t)) return;
  await insertOwned('ar-guarded', alice.id);
  const forbidden = [...AUTHOR_FORBIDDEN_FIELDS, 'archiveSha256', 'archiveBytes', 'archiveUrl'];

  for (const field of forbidden) {
    await t.test(`POST with ${field} -> 400, nothing created`, async () => {
      const id = `ar-forbid-${field}`;
      const res = await request(app).post('/api/catalog').set(alice.auth)
        .send(newScenario(id, { [field]: field === 'isPublished' ? true : 'x' })).expect(400);
      assert.match(res.body.error, new RegExp(field));
      assert.equal(await row(id), undefined);
    });

    await t.test(`PUT with ${field} -> 400, nothing changed`, async () => {
      await request(app).put('/api/catalog/ar-guarded').set(alice.auth)
        .send({ title: 'Sneaky', [field]: field === 'isPublished' ? true : 'x' }).expect(400);
      const unchanged = await row('ar-guarded');
      assert.equal(unchanged.title, 'Title');
      assert.equal(unchanged.status, 'draft');
    });
  }

  await t.test('null counts as sending the field', async () => {
    await request(app).put('/api/catalog/ar-guarded').set(alice.auth).send({ manifestUrl: null }).expect(400);
  });

  await t.test('a moderator may send every one of them', async () => {
    await request(app).put('/api/catalog/ar-guarded').set(mia.auth)
      .send({ author: 'Named By Mia', isPublished: false, imageUrl: '', scenarioUrl: '/scenarios/x.zip' })
      .expect(200);
    const changed = await row('ar-guarded');
    assert.equal(changed.author, 'Named By Mia');
    assert.equal(changed.status, 'draft', 'isPublished:false on a draft is a no-op');
  });
});

test('181. an author may only name an existing category (DW-2.4)', async t => {
  if (skipUnlessDb(t)) return;
  await insertOwned('ar-cat', alice.id);
  const before = await categoryCount();

  await t.test('POST with an unknown slug -> 400, no category and no scenario', async () => {
    await request(app).post('/api/catalog').set(alice.auth)
      .send(newScenario('ar-unknown-cat', { category: 'brand-new', categoryLabel: 'Brand new' })).expect(400);
    assert.equal(await row('ar-unknown-cat'), undefined);
    assert.equal(await categoryCount(), before);
  });

  await t.test('PUT with an unknown slug -> 400, no category, category unchanged', async () => {
    await request(app).put('/api/catalog/ar-cat').set(alice.auth)
      .send({ category: 'brand-new', categoryLabel: 'Brand new' }).expect(400);
    assert.equal((await row('ar-cat')).category, 'biology');
    assert.equal(await categoryCount(), before);
  });

  await t.test('a non-string category -> 400 (not a database error)', async () => {
    await request(app).post('/api/catalog').set(alice.auth).send(newScenario('ar-obj-cat', { category: { a: 1 } })).expect(400);
    await request(app).put('/api/catalog/ar-cat').set(alice.auth).send({ category: 5 }).expect(400);
  });

  await t.test('PUT to another existing category works and its label is not touched by categoryLabel', async () => {
    await request(app).put('/api/catalog/ar-cat').set(alice.auth)
      .send({ category: 'physics', categoryLabel: 'HIJACKED' }).expect(200);
    assert.equal((await row('ar-cat')).category, 'physics');
    const { rows } = await pool.query("SELECT label FROM categories WHERE slug = 'physics'");
    assert.equal(rows[0].label, 'Фізика');
    assert.equal(await categoryCount(), before);
  });

  await t.test('PUT of only categoryLabel is "nothing to update" (it is ignored)', async () => {
    await request(app).put('/api/catalog/ar-cat').set(alice.auth).send({ categoryLabel: 'X' }).expect(400);
  });

  await t.test('a moderator still creates a category from an unknown slug', async () => {
    await request(app).post('/api/catalog').set(mia.auth)
      .send({ id: 'ar-mod-cat', title: 'T', category: 'brand-new', categoryLabel: 'Brand new' }).expect(201);
    assert.equal(await categoryCount(), before + 1);
    const { rows } = await pool.query("SELECT label FROM categories WHERE slug = 'brand-new'");
    assert.equal(rows[0].label, 'Brand new');
  });
});

test('181. an author edits only their own scenario (DW-2.4)', async t => {
  if (skipUnlessDb(t)) return;
  await insertOwned('ar-alice', alice.id);
  await insertOwned('ar-alice-live', alice.id, { published: true });
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, owner_key_id)
    VALUES ('ar-legacy', 'Legacy', 'biology', 'Біологія', NULL) ON CONFLICT DO NOTHING`);

  await t.test('content fields of their own row, including features', async () => {
    await request(app).put('/api/catalog/ar-alice').set(alice.auth).send({
      title: 'New', description: 'd', fullDescription: 'f', version: '3.0.0',
      features: [{ icon: 'flask', title: 'Lab' }],
    }).expect(200);
    const changed = await row('ar-alice');
    assert.equal(changed.title, 'New');
    assert.equal(changed.version, '3.0.0');
    assert.deepEqual(changed.features, [{ icon: 'flask', title: 'Lab' }]);
    assert.equal(changed.owner_key_id, alice.id, 'ownership is not editable');
  });

  await t.test('in any status: a published own row can be edited too', async () => {
    await request(app).put('/api/catalog/ar-alice-live').set(alice.auth).send({ title: 'Edited live' }).expect(200);
    assert.equal((await row('ar-alice-live')).title, 'Edited live');
  });

  await t.test("another author's row -> 403, unchanged", async () => {
    await request(app).put('/api/catalog/ar-alice').set(bob.auth).send({ title: 'Bob was here' }).expect(403);
    assert.equal((await row('ar-alice')).title, 'New');
  });

  await t.test('a legacy row with no owner -> 403 for an author', async () => {
    await request(app).put('/api/catalog/ar-legacy').set(alice.auth).send({ title: 'Mine now' }).expect(403);
    assert.equal((await row('ar-legacy')).title, 'Legacy');
  });

  await t.test('an unknown id -> 404', async () => {
    await request(app).put('/api/catalog/ar-nope').set(alice.auth).send({ title: 'x' }).expect(404);
  });

  await t.test('a moderator edits any of them', async () => {
    await request(app).put('/api/catalog/ar-legacy').set(mia.auth).send({ title: 'Moderated' }).expect(200);
    assert.equal((await row('ar-legacy')).title, 'Moderated');
  });

  await t.test("an author cannot delete, even their own", async () => {
    await request(app).delete('/api/catalog/ar-alice').set(alice.auth).expect(403);
    assert.ok(await row('ar-alice'));
  });
});

test('181. moderators: author defaults to the key label, bootstrap has none', async t => {
  if (skipUnlessDb(t)) return;

  await request(app).post('/api/catalog').set(mia.auth)
    .send({ id: 'ar-mod-1', title: 'T', category: 'biology', categoryLabel: 'Біологія' }).expect(201);
  const byKey = await row('ar-mod-1');
  assert.equal(byKey.author, 'Mia');
  assert.equal(byKey.owner_key_id, mia.id);
  assert.equal(byKey.status, 'draft', 'every new row starts as a draft: it has no archive to approve');

  await request(app).post('/api/catalog').set(mia.auth)
    .send({ id: 'ar-mod-2', title: 'T', category: 'biology', categoryLabel: 'Біологія', author: 'Dr. Named' }).expect(201);
  assert.equal((await row('ar-mod-2')).author, 'Dr. Named');

  await request(app).post('/api/catalog').set({ Authorization: `Bearer ${process.env.ADMIN_TOKEN}` })
    .send({ id: 'ar-mod-3', title: 'T', category: 'biology', categoryLabel: 'Біологія' }).expect(201);
  const boot = await row('ar-mod-3');
  assert.equal(boot.author, null);
  assert.equal(boot.owner_key_id, null);
});

test('181. archive upload: owner in any status but review, moderator any time (DW-2.4, DW-3.3)', async t => {
  if (skipUnlessDb(t)) return;
  await insertOwned('ar-up-draft', alice.id);
  await insertOwned('ar-up-live', alice.id, { published: true });
  const upload = (id, as) => request(app).post(`/api/scenarios/${id}/archive`).set(as.auth)
    .attach('archive', validArchive(), 'scenario.zip');

  await t.test('into an own unpublished scenario -> 201', async () => {
    await upload('ar-up-draft', alice).expect(201);
    assert.match((await row('ar-up-draft')).archive_sha256, /^[0-9a-f]{64}$/);
  });

  await t.test('into an own PUBLISHED scenario -> 201 as a pending version, the row is untouched (Phase 3)', async () => {
    const res = await upload('ar-up-live', alice).expect(201);
    assert.equal(res.body.version.state, 'pending');
    assert.equal((await row('ar-up-live')).archive_sha256, null, 'students keep what they had');
    assert.deepEqual(await fsp.readdir(storage.TMP_DIR), []);
  });

  await t.test("into someone else's scenario -> 403", async () => {
    await upload('ar-up-draft', bob).expect(403);
  });

  await t.test('into an unknown scenario -> 404', async () => {
    await upload('ar-up-none', alice).expect(404);
  });

  await t.test('a moderator may upload into a published scenario -> 201', async () => {
    await upload('ar-up-live', mia).expect(201);
    assert.ok((await row('ar-up-live')).archive_sha256);
  });
});
