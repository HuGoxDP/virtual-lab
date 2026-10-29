// backend/test/integration/categories.test.js
//
// Test-plan scenario 198 (DW-4.1): category CRUD, reorder and visibility for moderators; the slug
// rule at 1/2/50/51 characters and uppercase; deleting a used category -> 409; and a hidden
// category's scenarios gone from the list, summary, related, `/:id` and `?version=` for the
// public (still reachable by their owner and moderators) - with the journal written for each change.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { removeArchiveRoot } = require('../helpers/app-env');
const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios, addCurrentVersion } = require('../helpers/db');
const { createKey } = require('../helpers/keys');

let available = false;
const keys = {};
const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

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

test.beforeEach(() => failedAuth.reset());

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

const mod = keys => keys.moderator.auth;
const slugsOf = res => res.body.categories.map(c => c.slug);
const audited = async action => (await pool.query('SELECT actor_label, details FROM audit_events WHERE action = $1 ORDER BY id', [action])).rows;

test('198. DW-4.1 create: moderator and bootstrap, appended after the last, journalled; duplicate -> 409', async t => {
  if (skipUnlessDb(t)) return;
  const { rows: [{ max }] } = await pool.query('SELECT MAX(sort_order)::int AS max FROM categories');

  const created = await request(app).post('/api/categories').set(mod(keys)).send({ slug: 'chemistry', label: ' Хімія ', icon: 'flask' }).expect(201);
  assert.deepEqual(created.body.category, { slug: 'chemistry', label: 'Хімія', icon: 'flask', sortOrder: max + 10, isVisible: true });

  const viaBootstrap = await request(app).post('/api/categories').set(BOOTSTRAP).send({ slug: 'history', label: 'Історія', isVisible: false }).expect(201);
  assert.deepEqual(viaBootstrap.body.category, { slug: 'history', label: 'Історія', icon: 'folder', sortOrder: max + 20, isVisible: false });

  const again = await request(app).post('/api/categories').set(mod(keys)).send({ slug: 'chemistry', label: 'Інша' }).expect(409);
  assert.match(again.body.error, /chemistry/);

  const events = await audited('category.create');
  assert.deepEqual(events.map(e => [e.actor_label, e.details.slug]), [['Mia', 'chemistry'], ['bootstrap', 'history']]);
});

test('198. DW-4.1 slug rule: 1 character -> 400, 2 -> 201, 50 -> 201, 51 -> 400, uppercase, space, underscore -> 400', async t => {
  if (skipUnlessDb(t)) return;
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM categories')).rows[0].n;
  const post = slug => request(app).post('/api/categories').set(mod(keys)).send({ slug, label: 'L' });

  await post('a').expect(400);
  await post('a'.repeat(51)).expect(400);
  await post('Physics2').expect(400);
  await post('has space').expect(400);
  await post('under_score').expect(400);
  await post('').expect(400);
  await request(app).post('/api/categories').set(mod(keys)).send({ label: 'no slug' }).expect(400);
  await post('s2').expect(201);
  await post('s'.repeat(50)).expect(201);

  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM categories')).rows[0].n, before + 2);
});

test('198. DW-4.1 create body: missing or blank label, bad icon, non-boolean isVisible -> 400 and nothing stored', async t => {
  if (skipUnlessDb(t)) return;
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM categories')).rows[0].n;
  const post = body => request(app).post('/api/categories').set(mod(keys)).send(body);
  await post({ slug: 'bad-one' }).expect(400);
  await post({ slug: 'bad-one', label: '   ' }).expect(400);
  await post({ slug: 'bad-one', label: 'x'.repeat(101) }).expect(400);
  await post({ slug: 'bad-one', label: 'L', icon: 'Not Valid' }).expect(400);
  await post({ slug: 'bad-one', label: 'L', isVisible: 'yes' }).expect(400);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM categories')).rows[0].n, before);
});

test('198. DW-4.1 GET /api/categories: any principal, ordered, hidden ones flagged; only a moderator sees counts', async t => {
  if (skipUnlessDb(t)) return;
  await request(app).post('/api/categories').set(mod(keys)).send({ slug: 'hidden-list', label: 'Hidden', isVisible: false }).expect(201);

  const asAuthor = await request(app).get('/api/categories').set(keys.author.auth).expect(200);
  const hidden = asAuthor.body.categories.find(c => c.slug === 'hidden-list');
  assert.equal(hidden.isVisible, false);
  assert.ok(asAuthor.body.categories.every(c => !('scenarioCount' in c)), 'an author does not learn other people\'s scenario counts');
  const orders = asAuthor.body.categories.map(c => c.sortOrder);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));

  const asModerator = await request(app).get('/api/categories').set(mod(keys)).expect(200);
  const biology = asModerator.body.categories.find(c => c.slug === 'biology');
  assert.equal(biology.scenarioCount, 3, 'every status counts: 3 biology scenarios in the seed');
  assert.equal(asModerator.body.categories.find(c => c.slug === 'hidden-list').scenarioCount, 0);

  await request(app).get('/api/categories').expect(401);
});

test('198. DW-4.1 PUT: label, icon and visibility; the label reaches the catalog and the scenarios; slug is not editable', async t => {
  if (skipUnlessDb(t)) return;
  await request(app).post('/api/categories').set(mod(keys)).send({ slug: 'edit-me', label: 'Old' }).expect(201);
  await pool.query(`INSERT INTO scenarios (id, title, category, category_label, status) VALUES ('edit-s', 'T', 'edit-me', 'Old', 'published')`);

  const res = await request(app).put('/api/categories/edit-me').set(mod(keys)).send({ label: 'New', icon: 'dna', slug: 'renamed' }).expect(200);
  assert.equal(res.body.category.slug, 'edit-me');
  assert.equal(res.body.category.label, 'New');
  assert.equal(res.body.category.icon, 'dna');
  assert.equal((await pool.query("SELECT category_label FROM scenarios WHERE id = 'edit-s'")).rows[0].category_label, 'New');
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM categories WHERE slug = 'renamed'")).rows[0].n, 0);

  const catalog = await request(app).get('/api/catalog').expect(200);
  assert.equal(catalog.body.categories.find(c => c.category === 'edit-me').categoryLabel, 'New');

  await request(app).put('/api/categories/edit-me').set(mod(keys)).send({}).expect(400);
  await request(app).put('/api/categories/edit-me').set(mod(keys)).send({ isVisible: 'no' }).expect(400);
  await request(app).put('/api/categories/nope').set(mod(keys)).send({ label: 'X' }).expect(404);
  assert.equal((await audited('category.update')).at(-1).details.label, 'New');
});

test('198. DW-4.1 reorder: the full list in a new order; partial, unknown, duplicate or malformed lists change nothing', async t => {
  if (skipUnlessDb(t)) return;
  const current = slugsOf(await request(app).get('/api/categories').set(mod(keys)).expect(200));
  const reversed = [...current].reverse();

  const done = await request(app).post('/api/categories/reorder').set(mod(keys)).send({ slugs: reversed }).expect(200);
  assert.deepEqual(slugsOf(done), reversed);
  assert.deepEqual(done.body.categories.map(c => c.sortOrder), reversed.map((_, i) => (i + 1) * 10));
  assert.deepEqual(slugsOf(await request(app).get('/api/categories').set(mod(keys))), reversed);
  assert.deepEqual((await audited('category.reorder')).at(-1).details.slugs, reversed);

  const same = async body => { await request(app).post('/api/categories/reorder').set(mod(keys)).send(body); };
  for (const [body, status] of [
    [{ slugs: reversed.slice(1) }, 409],
    [{ slugs: [...reversed, 'ghost'] }, 409],
    [{ slugs: [...reversed.slice(1), 'ghost'] }, 409],
    [{ slugs: [reversed[0], reversed[0], ...reversed.slice(2)] }, 400],
    [{ slugs: 'biology' }, 400],
    [{ slugs: [1, 2] }, 400],
    [{}, 400],
  ]) {
    await request(app).post('/api/categories/reorder').set(mod(keys)).send(body).expect(status);
  }
  await same({ slugs: reversed.slice(1) });
  assert.deepEqual(slugsOf(await request(app).get('/api/categories').set(mod(keys))), reversed, 'every refusal left the order alone');

  // The public chips follow the same order.
  const chips = (await request(app).get('/api/catalog').expect(200)).body.categories.map(c => c.category);
  assert.deepEqual(chips, reversed.filter(slug => chips.includes(slug)));
});

test('198. DW-4.1 delete: an unused category goes; one any scenario uses (any status) -> 409 and stays; unknown -> 404', async t => {
  if (skipUnlessDb(t)) return;
  await request(app).post('/api/categories').set(mod(keys)).send({ slug: 'empty-cat', label: 'E' }).expect(201);
  await request(app).post('/api/categories').set(mod(keys)).send({ slug: 'used-cat', label: 'U' }).expect(201);
  await pool.query(`INSERT INTO scenarios (id, title, category, category_label, status) VALUES ('used-s', 'T', 'used-cat', 'U', 'draft')`);

  const refused = await request(app).delete('/api/categories/used-cat').set(mod(keys)).expect(409);
  assert.match(refused.body.error, /1/);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM categories WHERE slug = 'used-cat'")).rows[0].n, 1);

  await request(app).delete('/api/categories/empty-cat').set(mod(keys)).expect(200);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM categories WHERE slug = 'empty-cat'")).rows[0].n, 0);
  await request(app).delete('/api/categories/empty-cat').set(mod(keys)).expect(404);
  assert.deepEqual((await audited('category.delete')).map(e => e.details.slug), ['empty-cat']);

  // Once its last scenario moves away, the category can go.
  await pool.query("UPDATE scenarios SET category = 'biology' WHERE id = 'used-s'");
  await request(app).delete('/api/categories/used-cat').set(mod(keys)).expect(200);
});

test('198. DW-4.1 an author cannot create, edit, delete or reorder; nothing changes', async t => {
  if (skipUnlessDb(t)) return;
  const before = (await pool.query('SELECT slug, label, sort_order FROM categories ORDER BY slug')).rows;
  const auth = keys.author.auth;
  await request(app).post('/api/categories').set(auth).send({ slug: 'by-author', label: 'X' }).expect(403);
  await request(app).put('/api/categories/biology').set(auth).send({ label: 'X' }).expect(403);
  await request(app).delete('/api/categories/biology').set(auth).expect(403);
  await request(app).post('/api/categories/reorder').set(auth).send({ slugs: [] }).expect(403);
  assert.deepEqual((await pool.query('SELECT slug, label, sort_order FROM categories ORDER BY slug')).rows, before);
});

test('198. DW-4.1 hiding a category: its scenarios leave the list, summary, chips, related, :id and ?version= for the public', async t => {
  if (skipUnlessDb(t)) return;
  await request(app).post('/api/categories').set(mod(keys)).send({ slug: 'to-hide', label: 'Hide me' }).expect(201);
  const sha = 'f'.repeat(64);
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id)
    VALUES ('hide-s', 'Hidden soon', 'to-hide', 'Hide me', 'published', $1)`, [keys.author.id]);
  await addCurrentVersion(pool, 'hide-s', sha);

  const listed = async () => {
    const list = await request(app).get('/api/catalog?limit=100').expect(200);
    const detail = await request(app).get('/api/catalog/hide-s');
    const related = await request(app).get('/api/catalog/solar-system').expect(200);
    const preview = await request(app).get(`/api/catalog/hide-s?version=${sha}`);
    return {
      inList: list.body.scenarios.some(s => s.id === 'hide-s'),
      inChips: list.body.categories.some(c => c.category === 'to-hide'),
      summary: list.body.summary.scenarios,
      total: list.body.total,
      detail: detail.status,
      inRelated: related.body.related.some(r => r.id === 'hide-s'),
      preview: preview.status,
    };
  };

  const shown = await listed();
  assert.deepEqual({ ...shown, summary: undefined, total: undefined }, {
    inList: true, inChips: true, summary: undefined, total: undefined, detail: 200, inRelated: true, preview: 200,
  });

  await request(app).put('/api/categories/to-hide').set(mod(keys)).send({ isVisible: false }).expect(200);
  const hidden = await listed();
  assert.deepEqual({ ...hidden, summary: undefined, total: undefined }, {
    inList: false, inChips: false, summary: undefined, total: undefined, detail: 404, inRelated: false, preview: 404,
  });
  assert.equal(hidden.summary, shown.summary - 1, 'the summary no longer counts it');
  assert.equal(hidden.total, shown.total - 1);

  // The scenario itself is untouched, and its owner and moderators still reach it (to fix or republish).
  assert.equal((await pool.query("SELECT status FROM scenarios WHERE id = 'hide-s'")).rows[0].status, 'published');
  assert.equal((await request(app).get(`/api/catalog/hide-s?version=${sha}`).set(keys.author.auth)).status, 200);
  assert.equal((await request(app).get(`/api/catalog/hide-s?version=${sha}`).set(mod(keys))).status, 200);
  const admin = await request(app).get('/api/admin/scenarios').set(keys.author.auth).expect(200);
  assert.ok(admin.body.scenarios.some(s => s.id === 'hide-s'));

  // And showing it again restores everything.
  await request(app).put('/api/categories/to-hide').set(mod(keys)).send({ isVisible: true }).expect(200);
  assert.deepEqual(await listed(), shown);
});

test('198. DW-4.1 a scenario whose category has no row at all stays public (no foreign key by design)', async t => {
  if (skipUnlessDb(t)) return;
  await pool.query(`INSERT INTO scenarios (id, title, category, category_label, status) VALUES ('no-cat-row', 'T', 'orphan-slug', 'Orphan', 'published')`);
  assert.equal((await request(app).get('/api/catalog/no-cat-row')).status, 200);
  const list = await request(app).get('/api/catalog?limit=100').expect(200);
  assert.ok(list.body.scenarios.some(s => s.id === 'no-cat-row'));
});
