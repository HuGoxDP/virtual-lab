// backend/test/integration/catalog-text-widths.test.js
//
// Test-plan scenario 181 (DW-2.4, found at VERIFY): every text field an author or a moderator sends to
// POST/PUT /api/catalog is checked against its column width. At the width it is stored; one over, it is a
// 400 with a Ukrainian message, never the database error that used to surface as a 500.

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
const { SCENARIO_TEXT_LIMITS } = require('../../catalog-input');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { createKey } = require('../helpers/keys');

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
const scenarioCount = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM scenarios')).rows[0].n;
const COLUMN = { categoryLabel: 'category_label', manifestUrl: 'manifest_url' };

test('181. the declared widths are the columns\' real widths', async t => {
  if (skipUnlessDb(t)) return;
  const { rows } = await pool.query(`
    SELECT column_name, character_maximum_length AS max FROM information_schema.columns
    WHERE table_name = 'scenarios' AND character_maximum_length IS NOT NULL
  `);
  const widths = Object.fromEntries(rows.map(r => [r.column_name, r.max]));
  for (const [name, { max }] of Object.entries(SCENARIO_TEXT_LIMITS)) {
    assert.equal(widths[COLUMN[name] ?? name], max, `${name} must match its column`);
  }
});

test('181. POST /api/catalog by a moderator: each field at its width is stored, one over is 400 (DW-2.4)', async t => {
  if (skipUnlessDb(t)) return;

  for (const name of ['id', 'title', 'category', 'categoryLabel', 'version', 'author']) {
    const { max } = SCENARIO_TEXT_LIMITS[name];
    // id and category are slugs; the rest take any text.
    const text = n => (name === 'id' || name === 'category' ? 'c'.repeat(n) : 'Ж'.repeat(n));
    const body = value => ({ id: 'tw-m', title: 'T', category: 'tw-cat', categoryLabel: 'Лейбл', [name]: value });

    await t.test(`${name}: ${max} characters is stored`, async () => {
      const sent = body(text(max));
      const res = await request(app).post('/api/catalog').set(mia.auth).send(sent).expect(201);
      assert.ok(await row(sent.id), 'the row exists');
      await pool.query('DELETE FROM scenarios WHERE id = $1', [res.body.id]);
      await pool.query('DELETE FROM categories WHERE slug = $1', [sent.category]);
    });

    await t.test(`${name}: ${max + 1} characters -> 400 naming the field, nothing stored`, async () => {
      const before = await scenarioCount();
      const res = await request(app).post('/api/catalog').set(mia.auth).send(body(text(max + 1))).expect(400);
      assert.equal(res.body.error, `${name}: не більше ${max} символів`);
      assert.equal(await scenarioCount(), before);
    });
  }
});

test('181. POST /api/catalog by an author: a 300-character title is 400, 255 is stored (DW-2.4)', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('255 unbroken characters', async () => {
    const title = 'Ж'.repeat(255);
    await request(app).post('/api/catalog').set(alice.auth).send({ id: 'tw-a-255', title, category: 'biology' }).expect(201);
    assert.equal((await row('tw-a-255')).title, title);
  });

  await t.test('300 characters (the VERIFY failure) -> 400, never 500', async () => {
    const res = await request(app).post('/api/catalog').set(alice.auth)
      .send({ id: 'tw-a-300', title: 'Ж'.repeat(300), category: 'biology' }).expect(400);
    assert.equal(res.body.error, 'title: не більше 255 символів');
    assert.equal(await row('tw-a-300'), undefined);
  });

  await t.test('a non-string title -> 400', async () => {
    await request(app).post('/api/catalog').set(alice.auth)
      .send({ id: 'tw-a-arr', title: ['x'], category: 'biology' }).expect(400);
  });

  await t.test('the width counts characters, not UTF-16 units: 255 emoji are stored, 256 are not', async () => {
    await request(app).post('/api/catalog').set(alice.auth)
      .send({ id: 'tw-a-emoji', title: '😀'.repeat(255), category: 'biology' }).expect(201);
    assert.equal(Array.from((await row('tw-a-emoji')).title).length, 255);
    await request(app).post('/api/catalog').set(alice.auth)
      .send({ id: 'tw-a-emoji2', title: '😀'.repeat(256), category: 'biology' }).expect(400);
  });
});

test('181. PUT /api/catalog/:id: widths and types (DW-2.4)', async t => {
  if (skipUnlessDb(t)) return;
  await request(app).post('/api/catalog').set(alice.auth).send({ id: 'tw-put', title: 'Old', category: 'biology' }).expect(201);

  await t.test('title at 255 is saved; at 256 -> 400 and the row is unchanged', async () => {
    await request(app).put('/api/catalog/tw-put').set(alice.auth).send({ title: 'Ш'.repeat(255) }).expect(200);
    assert.equal((await row('tw-put')).title.length, 255);
    const res = await request(app).put('/api/catalog/tw-put').set(alice.auth).send({ title: 'Ш'.repeat(256) }).expect(400);
    assert.equal(res.body.error, 'title: не більше 255 символів');
    assert.equal((await row('tw-put')).title.length, 255);
  });

  await t.test('version at 20 is saved; at 21 -> 400', async () => {
    await request(app).put('/api/catalog/tw-put').set(alice.auth).send({ version: '1'.repeat(20) }).expect(200);
    await request(app).put('/api/catalog/tw-put').set(alice.auth).send({ version: '1'.repeat(21) }).expect(400);
  });

  await t.test('a null title (NOT NULL) -> 400, not a database error', async () => {
    await request(app).put('/api/catalog/tw-put').set(alice.auth).send({ title: null }).expect(400);
  });

  await t.test('a moderator: manifestUrl 300 saved, 301 -> 400, null still clears it', async () => {
    const url = n => 'https://x.example/' + 'a'.repeat(n - 'https://x.example/'.length);
    await request(app).put('/api/catalog/tw-put').set(mia.auth).send({ manifestUrl: url(300) }).expect(200);
    await request(app).put('/api/catalog/tw-put').set(mia.auth).send({ manifestUrl: url(301) }).expect(400);
    await request(app).put('/api/catalog/tw-put').set(mia.auth).send({ manifestUrl: null }).expect(200);
    assert.equal((await row('tw-put')).manifest_url, null);
  });

  await t.test('a moderator: author 255 saved, 256 -> 400', async () => {
    await request(app).put('/api/catalog/tw-put').set(mia.auth).send({ author: 'А'.repeat(255) }).expect(200);
    await request(app).put('/api/catalog/tw-put').set(mia.auth).send({ author: 'А'.repeat(256) }).expect(400);
  });

  await t.test('a moderator: categoryLabel 100 saved, 101 -> 400', async () => {
    await request(app).put('/api/catalog/tw-put').set(mia.auth).send({ categoryLabel: 'К'.repeat(100) }).expect(200);
    await request(app).put('/api/catalog/tw-put').set(mia.auth).send({ categoryLabel: 'К'.repeat(101) }).expect(400);
  });

  await t.test('a moderator: a category slug of 51 characters -> 400 (it would be a new category row)', async () => {
    await request(app).put('/api/catalog/tw-put').set(mia.auth).send({ category: 'c'.repeat(51), categoryLabel: 'L' }).expect(400);
  });
});
