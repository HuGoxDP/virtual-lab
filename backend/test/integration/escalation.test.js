// backend/test/integration/escalation.test.js
//
// B6 (DW-6.3): an author tries to raise their own rights. `AUTHOR_FORBIDDEN_FIELDS`
// and anything named `archive*` are refused with a 400; the aliases that decide
// ownership or visibility without being a listed field — `ownerKeyId`,
// `owner_key_id`, `status` — are simply not read, so the row keeps the values the
// server derives; and every moderator-only route answers 403. This pins the
// "escalation bodies" row of the card's review focus.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { AUTHOR_FORBIDDEN_FIELDS } = require('../../catalog-input');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { createKey } = require('../helpers/keys');

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

let available = false;
let author, stranger;
const ESC = 'esc-row';

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  await truncateAll(pool);
  // `biology` must exist: an author may only name a category that is already there.
  await seedScenarios(pool);
  author = await createKey(pool, 'author', 'Esc Author');
  stranger = await createKey(pool, 'author', 'Esc Stranger');
});

test.beforeEach(() => { failedAuth.reset(); authorUploads.reset(); });

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

const row = async id => (await pool.query('SELECT * FROM scenarios WHERE id = $1', [id])).rows[0];

test('B6.3 an author cannot escalate on create', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('a listed field is refused outright, and nothing is written', async () => {
    for (const field of AUTHOR_FORBIDDEN_FIELDS) {
      const res = await request(app).post('/api/catalog').set(author.auth)
        .send({ id: ESC, title: 'Ескалація', category: 'biology', [field]: field === 'isPublished' ? true : 'x' })
        .expect(400);
      assert.match(res.body.error, new RegExp(field), `the refusal names ${field}`);
      assert.equal(await row(ESC), undefined, `no row from the ${field} attempt`);
    }
  });

  await t.test('the aliases are not read: the row is the callers, a draft, unpublished', async () => {
    const res = await request(app).post('/api/catalog').set(author.auth)
      .send({
        id: ESC, title: 'Ескалація', description: 'd', category: 'biology',
        ownerKeyId: stranger.id,
        owner_key_id: stranger.id,
        status: 'published',
      })
      .expect(201);
    assert.equal(res.body.id, ESC);
    const created = await row(ESC);
    assert.equal(created.owner_key_id, author.id, 'ownership is never taken from the body');
    assert.equal(created.status, 'draft', 'approval is a moderator action');
    assert.equal(created.author, 'Esc Author', 'attribution is the key label');
  });
});

test('B6.3 an author cannot escalate on update', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('the aliases change nothing on a PUT', async () => {
    await request(app).put(`/api/catalog/${ESC}`).set(author.auth)
      .send({ title: 'Відредаговано', ownerKeyId: stranger.id, owner_key_id: stranger.id, status: 'published' })
      .expect(200);
    const updated = await row(ESC);
    assert.equal(updated.owner_key_id, author.id);
    assert.equal(updated.status, 'draft');
    assert.equal(updated.author, 'Esc Author');
    assert.equal(updated.title, 'Відредаговано', 'the content field did apply');
  });

  await t.test('a PUT with a listed field is refused, not ignored', async () => {
    for (const field of AUTHOR_FORBIDDEN_FIELDS) {
      const res = await request(app).put(`/api/catalog/${ESC}`).set(author.auth)
        .send({ title: 'Підміна', [field]: field === 'isPublished' ? true : 'https://x/' })
        .expect(400);
      assert.match(res.body.error, new RegExp(field));
    }
    assert.equal((await row(ESC)).title, 'Відредаговано');
  });
});

test('B6.3 an author cannot call the moderator-only routes', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('every moderator-only action is 403 for an author', async () => {
    for (const call of [
      () => request(app).post(`/api/scenarios/${ESC}/approve`).set(author.auth),
      () => request(app).post(`/api/scenarios/${ESC}/reject`).set(author.auth).send({ note: 'no' }),
      () => request(app).post(`/api/keys/${author.id}/rotate`).set(author.auth),
      () => request(app).post(`/api/keys/${author.id}/revoke`).set(author.auth),
      () => request(app).put(`/api/scenarios/${ESC}/owner`).set(author.auth).send({ keyId: stranger.id }),
      () => request(app).post('/api/keys').set(author.auth).send({ label: 'x', role: 'moderator' }),
      () => request(app).get('/api/keys').set(author.auth),
    ]) {
      const res = await call();
      assert.equal(res.status, 403, `${res.req.method} ${res.req.path} answered ${res.status}`);
    }
  });

  await t.test('the dashboard is an author route but shows the caller only their own rows', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(author.auth).expect(200);
    // `seedScenarios` left published rows owned by nobody; the author owns the one
    // draft they just tried to publish, so that is all a 200 may carry.
    assert.equal(res.body.counts.draft, 1);
    assert.equal(res.body.counts.published, 0);
    assert.equal(res.body.counts.review, 0);
    assert.equal(res.body.queueSize, 0);
    // Newest first: the PUT of the previous test, then the create. Nothing the
    // seeded (unowned) rows did, and nothing stranger's.
    assert.deepEqual(res.body.activity.map(a => a.action), ['scenario.update', 'scenario.create']);
    assert.ok(res.body.activity.every(a => a.scenarioId === ESC), 'no foreign scenario in the journal');
  });

  await t.test('and the row is still the authors draft', async () => {
    const esc = await row(ESC);
    assert.equal(esc.owner_key_id, author.id);
    assert.equal(esc.status, 'draft');
    const keys = await pool.query('SELECT COUNT(*)::int AS n FROM publish_keys');
    assert.equal(keys.rows[0].n, 2, 'no key was created or revoked');
  });

  await t.test('the bootstrap token is a moderator and may approve', async () => {
    const { addCurrentVersion } = require('../helpers/db');
    await addCurrentVersion(pool, ESC, 'a'.repeat(64));
    await request(app).post(`/api/scenarios/${ESC}/approve`).set(BOOTSTRAP).expect(200);
  });
});
