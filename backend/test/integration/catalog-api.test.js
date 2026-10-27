// backend/test/integration/catalog-api.test.js
//
// Covers test-plan scenarios 99–105 and 108–110 (Nocturne release 1, phase 1):
// migration 006, the richer catalog payload, server-side sort, related
// scenarios and admin `features`. Runs against a real Postgres.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');

const { app, pool } = require('../../server');
const { isAvailable, prepareSchema, truncateAll, setStatus } = require('../helpers/db');

const AUTH = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

let available = false;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
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

let counter = 0;

/** Inserts a scenario with sensible defaults; `createdAt` keeps ordering deterministic. */
async function addScenario(over = {}) {
  const n = ++counter;
  const row = {
    id: `s${n}`, title: `Title ${n}`, description: '', category: 'physics', categoryLabel: 'Фізика',
    published: true, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), ...over,
  };
  await pool.query(`
    INSERT INTO scenarios (id, title, description, category, category_label, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [row.id, row.title, row.description, row.category, row.categoryLabel, row.published ? 'published' : 'draft', row.createdAt]);
  return row;
}

const addCategory = (slug, label, icon, sortOrder, visible = true) => pool.query(
  'INSERT INTO categories (slug, label, icon, sort_order, is_visible) VALUES ($1,$2,$3,$4,$5)',
  [slug, label, icon, sortOrder, visible]
);

const ids = res => res.body.scenarios.map(s => s.id);

const MIGRATION_006 = path.join(__dirname, '../../migrations/006_categories_and_features.sql');

// ══════════════════════════════════════════════════════
// DW-1.1 — migration 006
// ══════════════════════════════════════════════════════

test('99. [DW-1.1] migration 006 seeds categories and applies twice', async t => {
  if (skipUnlessDb(t)) return;

  await truncateAll(pool);
  await addScenario({ id: 'm1', category: 'physics', categoryLabel: 'Фізика' });
  await addScenario({ id: 'm2', category: 'physics', categoryLabel: 'Фізика' });
  await addScenario({ id: 'm3', category: 'biology', categoryLabel: 'Біологія' });
  await addScenario({ id: 'm4', category: 'astronomy', categoryLabel: 'Астрономія' });
  await addScenario({ id: 'm5', category: 'chemistry', categoryLabel: 'Хімія' });
  await addScenario({ id: 'm6', category: 'history', categoryLabel: 'Історія' });
  await addScenario({ id: 'm7', category: 'test', categoryLabel: 'Тест' });
  await addScenario({ id: 'm8', category: 'misc', categoryLabel: 'Різне' });
  await pool.query('DELETE FROM categories');

  const sql = await fsp.readFile(MIGRATION_006, 'utf8');
  await pool.query(sql);
  await pool.query(sql); // the second run must be a harmless no-op

  const { rows } = await pool.query('SELECT * FROM categories ORDER BY sort_order');

  await t.test('one row per distinct scenarios.category', () => {
    assert.deepEqual(rows.map(r => r.slug).sort(),
      ['astronomy', 'biology', 'chemistry', 'history', 'misc', 'physics', 'test']);
  });

  await t.test('icons follow the prototype, any other slug gets folder', () => {
    const icon = Object.fromEntries(rows.map(r => [r.slug, r.icon]));
    assert.deepEqual(icon, {
      physics: 'lightning', biology: 'dna', chemistry: 'flask', history: 'bank',
      astronomy: 'planet', test: 'cube', misc: 'folder',
    });
  });

  await t.test('sort_order follows label order (Ukrainian) in steps of 10', () => {
    // Астрономія, Біологія, Історія, Різне, Тест, Фізика, Хімія
    assert.deepEqual(rows.map(r => [r.slug, r.sort_order]), [
      ['astronomy', 10], ['biology', 20], ['history', 30], ['misc', 40],
      ['test', 50], ['physics', 60], ['chemistry', 70],
    ]);
  });

  await t.test('new categories are visible; the second run did not duplicate or reorder', () => {
    assert.ok(rows.every(r => r.is_visible === true));
    assert.equal(rows.length, 7);
  });

  await t.test('scenarios.features defaults to []', async () => {
    const res = await pool.query('SELECT features FROM scenarios WHERE id = $1', ['m1']);
    assert.deepEqual(res.rows[0].features, []);
  });

  await t.test('the runner records 006 as applied', async () => {
    const res = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', ['006_categories_and_features.sql']);
    assert.equal(res.rowCount, 1);
  });
});

// ══════════════════════════════════════════════════════
// DW-1.2 — payload shape, categories, summary
// ══════════════════════════════════════════════════════

test('100. [DW-1.2] catalog item and category shape', async t => {
  if (skipUnlessDb(t)) return;

  await truncateAll(pool);
  await addCategory('physics', 'Фізика', 'lightning', 20);
  await addCategory('biology', 'Біологія', 'dna', 10);
  await addScenario({ id: 'a', category: 'physics', categoryLabel: 'stale label' });
  await addScenario({ id: 'b', category: 'biology', categoryLabel: 'Біологія' });
  await pool.query(`UPDATE scenarios SET archive_bytes = 5000000000, features = $1::jsonb WHERE id = 'a'`,
    [JSON.stringify([{ icon: 'atom', title: 'Т', subtitle: 'П' }])]);

  const res = await request(app).get('/api/catalog').expect(200);
  const a = res.body.scenarios.find(s => s.id === 'a');
  const b = res.body.scenarios.find(s => s.id === 'b');

  await t.test('item carries archiveBytes as a number (BIGINT beyond int32), updatedAt and features', () => {
    assert.equal(a.archiveBytes, 5_000_000_000);
    assert.equal(typeof a.updatedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(a.updatedAt)));
    assert.deepEqual(a.features, [{ icon: 'atom', title: 'Т', subtitle: 'П' }]);
  });

  await t.test('no archive -> archiveBytes null, features []', () => {
    assert.equal(b.archiveBytes, null);
    assert.deepEqual(b.features, []);
  });

  await t.test('categories.label is canonical over the scenario row', () => {
    assert.equal(a.categoryLabel, 'Фізика');
  });

  await t.test('categories list icon and count, ordered by sort_order', () => {
    assert.deepEqual(res.body.categories, [
      { category: 'biology', categoryLabel: 'Біологія', icon: 'dna', count: 1 },
      { category: 'physics', categoryLabel: 'Фізика', icon: 'lightning', count: 1 },
    ]);
  });

  await t.test('version and summary are present', () => {
    assert.equal(res.body.version, '1');
    assert.deepEqual(res.body.summary, { scenarios: 2, categories: 2 });
  });
});

test('101. [DW-1.2] summary and category counts ignore category/q; hidden and empty categories are absent', async t => {
  if (skipUnlessDb(t)) return;

  await truncateAll(pool);
  await addCategory('physics', 'Фізика', 'lightning', 10);
  await addCategory('biology', 'Біологія', 'dna', 20);
  await addCategory('secret', 'Секрет', 'folder', 30, false);
  await addCategory('drafts', 'Чернетки', 'folder', 40);
  await addScenario({ id: 'p1', category: 'physics', title: 'Маятник' });
  await addScenario({ id: 'p2', category: 'physics', title: 'Лінза' });
  await addScenario({ id: 'b1', category: 'biology', title: 'Клітина' });
  await addScenario({ id: 'x1', category: 'secret', categoryLabel: 'Секрет', title: 'Прихована категорія' });
  await addScenario({ id: 'd1', category: 'drafts', categoryLabel: 'Чернетки', published: false });

  const plain = await request(app).get('/api/catalog').expect(200);
  const filtered = await request(app).get('/api/catalog?category=biology&q=клітина').expect(200);

  await t.test('filtering narrows scenarios/total only', () => {
    assert.equal(filtered.body.total, 1);
    assert.deepEqual(filtered.body.categories, plain.body.categories);
    assert.deepEqual(filtered.body.summary, plain.body.summary);
  });

  await t.test('count = published scenarios in the category', () => {
    assert.deepEqual(plain.body.categories.map(c => [c.category, c.count]), [['physics', 2], ['biology', 1]]);
  });

  await t.test('is_visible=false and published-less categories are absent from categories and summary', () => {
    const slugs = plain.body.categories.map(c => c.category);
    assert.ok(!slugs.includes('secret'));
    assert.ok(!slugs.includes('drafts'));
    // 3 public scenarios (a hidden category's one is treated as unpublished: Phase 4), 2 visible categories.
    assert.deepEqual(plain.body.summary, { scenarios: 3, categories: 2 });
  });

  await t.test('a scenario in a hidden category is not listed', () => {
    assert.ok(!ids(plain).includes('x1'));
  });
});

// ══════════════════════════════════════════════════════
// DW-1.3 — sort, paging, dirty input
// ══════════════════════════════════════════════════════

const UK_TITLES = ['Яблуко', 'Їжак', 'Іграшка', 'Єнот', 'Ґанок', 'Zebra', 'Apple'];

async function seedForSort() {
  await truncateAll(pool);
  // created_at order = insertion order, so sort=new is the reverse of this list.
  for (const title of UK_TITLES) await addScenario({ id: `t-${title}`, title });
}

test('102. [DW-1.3] sort=title is Ukrainian alphabetical, sort=new is newest first', async t => {
  if (skipUnlessDb(t)) return;
  await seedForSort();

  await t.test('і, ї, є, ґ sit where the Ukrainian alphabet puts them (Ґ < Є < І < Ї < Я)', async () => {
    const res = await request(app).get('/api/catalog?sort=title').expect(200);
    const titles = res.body.scenarios.map(s => s.title);
    const cyrillic = titles.filter(x => /[Ѐ-ӿ]/.test(x));
    assert.deepEqual(cyrillic, ['Ґанок', 'Єнот', 'Іграшка', 'Їжак', 'Яблуко']);
  });

  await t.test('Latin titles sort among themselves alphabetically', async () => {
    const res = await request(app).get('/api/catalog?sort=title').expect(200);
    const latin = res.body.scenarios.map(s => s.title).filter(x => /^[A-Za-z]/.test(x));
    assert.deepEqual(latin, ['Apple', 'Zebra']);
  });

  await t.test('sort=new keeps created_at DESC, id DESC', async () => {
    const res = await request(app).get('/api/catalog?sort=new').expect(200);
    assert.deepEqual(res.body.scenarios.map(s => s.title), [...UK_TITLES].reverse());
  });

  await t.test('no sort parameter equals sort=new', async () => {
    const a = await request(app).get('/api/catalog').expect(200);
    const b = await request(app).get('/api/catalog?sort=new').expect(200);
    assert.deepEqual(ids(a), ids(b));
  });
});

test('103. [DW-1.3] paging boundaries and dirty sort/q', async t => {
  if (skipUnlessDb(t)) return;
  await seedForSort();
  for (let i = 0; i < 100; i++) await addScenario({ title: `Bulk ${String(i).padStart(3, '0')}` });
  const TOTAL = UK_TITLES.length + 100;

  for (const sort of ['new', 'title']) {
    await t.test(`limit boundaries under sort=${sort}`, async () => {
      const get = q => request(app).get(`/api/catalog?sort=${sort}&${q}`).expect(200);
      assert.equal((await get('limit=0')).body.limit, 24);   // 0 is junk -> default
      assert.equal((await get('limit=1')).body.scenarios.length, 1);
      assert.equal((await get('limit=100')).body.scenarios.length, 100);
      const over = await get('limit=101');
      assert.equal(over.body.limit, 100);
      assert.equal(over.body.scenarios.length, 100);
    });

    await t.test(`pages are disjoint and cover everything under sort=${sort}`, async () => {
      const seen = [];
      for (let offset = 0; offset < TOTAL; offset += 40) {
        const res = await request(app).get(`/api/catalog?sort=${sort}&limit=40&offset=${offset}`).expect(200);
        seen.push(...ids(res));
      }
      assert.equal(seen.length, TOTAL);
      assert.equal(new Set(seen).size, TOTAL);
    });

    await t.test(`offset past the end is an empty page under sort=${sort}`, async () => {
      const res = await request(app).get(`/api/catalog?sort=${sort}&offset=${TOTAL + 50}`).expect(200);
      assert.deepEqual(res.body.scenarios, []);
      assert.equal(res.body.total, TOTAL);
    });
  }

  await t.test('empty, unknown, injected and array sort all fall back to new', async () => {
    const expected = ids(await request(app).get('/api/catalog?sort=new&limit=30').expect(200));
    for (const q of ['sort=', 'sort=DROP', 'sort=title%3BDROP%20TABLE%20scenarios', 'sort=TITLE',
      'sort[]=a&sort[]=b', 'sort[]=title', 'sort[a]=title', 'sort=title&sort=new']) {
      const res = await request(app).get(`/api/catalog?limit=30&${q}`).expect(200);
      assert.deepEqual(ids(res), expected, q);
    }
  });

  await t.test('q with % and _ stays literal', async () => {
    await addScenario({ id: 'pct', title: 'Знижка 100% вдала' });
    await addScenario({ id: 'und', title: 'snake_case назва' });
    const pct = await request(app).get(`/api/catalog?q=${encodeURIComponent('100%')}`).expect(200);
    assert.deepEqual(ids(pct), ['pct']);
    const und = await request(app).get(`/api/catalog?q=${encodeURIComponent('e_c')}`).expect(200);
    assert.deepEqual(ids(und), ['und']);
    const lone = await request(app).get(`/api/catalog?q=${encodeURIComponent('_')}`).expect(200);
    assert.deepEqual(ids(lone), ['und']);
  });

  await t.test('array category/q do not crash', async () => {
    await request(app).get('/api/catalog?q[]=a&category[]=b').expect(200);
  });
});

// ══════════════════════════════════════════════════════
// DW-1.4 — related
// ══════════════════════════════════════════════════════

test('104. [DW-1.4] related scenarios', async t => {
  if (skipUnlessDb(t)) return;

  await truncateAll(pool);
  await addCategory('physics', 'Фізика', 'lightning', 10);
  await addCategory('biology', 'Біологія', 'dna', 20);
  await addCategory('lonely', 'Самотня', 'folder', 30);
  // oldest -> newest
  await addScenario({ id: 'bio-old', category: 'biology', categoryLabel: 'Біологія' });
  await addScenario({ id: 'phys-1', category: 'physics', categoryLabel: 'Фізика' });
  await addScenario({ id: 'phys-2', category: 'physics', categoryLabel: 'Фізика' });
  await addScenario({ id: 'phys-3', category: 'physics', categoryLabel: 'Фізика' });
  await addScenario({ id: 'phys-hidden', category: 'physics', categoryLabel: 'Фізика', published: false });
  await addScenario({ id: 'bio-new', category: 'biology', categoryLabel: 'Біологія' });
  await addScenario({ id: 'only', category: 'lonely', categoryLabel: 'Самотня' });

  const related = async id => (await request(app).get(`/api/catalog/${id}`).expect(200)).body.related;

  await t.test('same category first (newest first), at most 2, never itself, never unpublished', async () => {
    const r = await related('phys-1');
    assert.deepEqual(r.map(x => x.id), ['phys-3', 'phys-2']);
  });

  await t.test('items carry id, title, category, canonical categoryLabel and imageUrl only', async () => {
    const [first] = await related('phys-1');
    assert.deepEqual(Object.keys(first).sort(), ['category', 'categoryLabel', 'id', 'imageUrl', 'title']);
    assert.equal(first.categoryLabel, 'Фізика');
  });

  await t.test('one same-category peer is topped up from other categories', async () => {
    const r = await related('bio-old');
    assert.deepEqual(r.map(x => x.id), ['bio-new', 'only']);
  });

  await t.test('a lone-category scenario gets 2 from others, newest first', async () => {
    const r = await related('only');
    assert.deepEqual(r.map(x => x.id), ['bio-new', 'phys-3']);
  });

  await t.test('a catalog with a single scenario has empty related', async () => {
    await pool.query(`DELETE FROM scenarios WHERE id <> 'only'`);
    assert.deepEqual(await related('only'), []);
  });
});

test('105. [DW-1.4] by-id dirty input -> 404', async t => {
  if (skipUnlessDb(t)) return;

  await truncateAll(pool);
  await addScenario({ id: 'pub' });
  await addScenario({ id: 'draft', published: false });

  await t.test('unpublished id', () => request(app).get('/api/catalog/draft').expect(404));
  await t.test('unknown id', () => request(app).get('/api/catalog/nope').expect(404));
  await t.test('id with an encoded slash', () => request(app).get('/api/catalog/pub%2Fx').expect(404));
  await t.test('the published one still resolves, with the new item fields', async () => {
    const res = await request(app).get('/api/catalog/pub').expect(200);
    assert.deepEqual(res.body.features, []);
    assert.ok('archiveBytes' in res.body && 'updatedAt' in res.body && Array.isArray(res.body.related));
  });
});

// ══════════════════════════════════════════════════════
// DW-1.6 — admin features and category upsert
// ══════════════════════════════════════════════════════

const goodFeature = (over = {}) => ({ icon: 'atom', title: 'Заголовок', subtitle: 'Підзаголовок', ...over });

/**
 * POSTs as the bootstrap moderator. A created row starts as a draft, so on a 201 it is published
 * in SQL: these tests read what the public catalog shows of what the admin wrote.
 */
function postScenario(id, extra = {}) {
  const sent = request(app).post('/api/catalog').set(AUTH).send({
    id, title: 'Т', category: 'physics', categoryLabel: 'Фізика', ...extra,
  });
  return {
    async expect(status) {
      const res = await sent.expect(status);
      if (status === 201) await setStatus(pool, id, 'published');
      return res;
    },
  };
}

test('108. [DW-1.6] features: accepting boundaries (POST and PUT)', async t => {
  if (skipUnlessDb(t)) return;
  await truncateAll(pool);

  const cases = {
    'six items': Array.from({ length: 6 }, (_, i) => goodFeature({ title: `П${i}` })),
    'title of 60': [goodFeature({ title: 'я'.repeat(60) })],
    'subtitle of 90': [goodFeature({ subtitle: 'я'.repeat(90) })],
    'subtitle absent': [{ icon: 'atom', title: 'Без підзаголовка' }],
    'icon of 40': [goodFeature({ icon: 'a'.repeat(40) })],
    'empty list': [],
  };

  let n = 0;
  for (const [name, features] of Object.entries(cases)) {
    await t.test(`POST accepts ${name}`, async () => {
      const id = `ok-${++n}`;
      await postScenario(id, { features }).expect(201);
      const res = await request(app).get(`/api/catalog/${id}`).expect(200);
      assert.deepEqual(res.body.features, features);
    });
  }

  await t.test('PUT replaces features and the admin list returns them', async () => {
    await request(app).put('/api/catalog/ok-1').set(AUTH).send({ features: [goodFeature()] }).expect(200);
    const list = await request(app).get('/api/admin/scenarios').set(AUTH).expect(200);
    assert.deepEqual(list.body.scenarios.find(s => s.id === 'ok-1').features, [goodFeature()]);
  });

  await t.test('a PUT without features leaves them alone', async () => {
    await request(app).put('/api/catalog/ok-1').set(AUTH).send({ title: 'Нова' }).expect(200);
    const res = await request(app).get('/api/catalog/ok-1').expect(200);
    assert.deepEqual(res.body.features, [goodFeature()]);
  });

  await t.test('POST without features stores []', async () => {
    await postScenario('plain').expect(201);
    assert.deepEqual((await request(app).get('/api/catalog/plain').expect(200)).body.features, []);
  });

  await t.test('extra keys on an item are dropped and the title is trimmed', async () => {
    await postScenario('trim', { features: [{ icon: 'atom', title: '  Тест  ', evil: '<script>' }] }).expect(201);
    const res = await request(app).get('/api/catalog/trim').expect(200);
    assert.deepEqual(res.body.features, [{ icon: 'atom', title: 'Тест' }]);
  });
});

test('109. [DW-1.6] features: every invalid shape -> 400 in Ukrainian', async t => {
  if (skipUnlessDb(t)) return;
  await truncateAll(pool);
  await postScenario('target').expect(201);

  const dirty = {
    'seven items': Array.from({ length: 7 }, () => goodFeature()),
    'icon Atom': [goodFeature({ icon: 'Atom' })],
    'icon ../x': [goodFeature({ icon: '../x' })],
    'icon of 41': [goodFeature({ icon: 'a'.repeat(41) })],
    'empty icon': [goodFeature({ icon: '' })],
    'numeric icon': [goodFeature({ icon: 5 })],
    'empty title': [goodFeature({ title: '' })],
    'blank title': [goodFeature({ title: '   ' })],
    'title of 61': [goodFeature({ title: 'я'.repeat(61) })],
    'subtitle of 91': [goodFeature({ subtitle: 'я'.repeat(91) })],
    'numeric subtitle': [goodFeature({ subtitle: 7 })],
    'object instead of array': { icon: 'atom', title: 'x' },
    'string instead of array': 'features',
    'null': null,
    'item null': [null],
    'item string': ['atom'],
    'item array': [[]],
  };

  for (const [name, features] of Object.entries(dirty)) {
    await t.test(`${name} -> 400 on POST and PUT`, async () => {
      const post = await postScenario(`bad-${name.replace(/\W/g, '')}`, { features }).expect(400);
      assert.match(post.body.error, /features/);
      const put = await request(app).put('/api/catalog/target').set(AUTH).send({ features }).expect(400);
      assert.match(put.body.error, /features/);
    });
  }

  await t.test('rejected writes changed nothing', async () => {
    const { rowCount } = await pool.query(`SELECT 1 FROM scenarios WHERE id LIKE 'bad-%'`);
    assert.equal(rowCount, 0);
    assert.deepEqual((await request(app).get('/api/catalog/target').expect(200)).body.features, []);
  });
});

test('110. [DW-1.6] category upsert, canonical label, stored features, slug without a row', async t => {
  if (skipUnlessDb(t)) return;
  await truncateAll(pool);
  await addCategory('physics', 'Фізика', 'lightning', 30);

  await t.test('an unknown slug creates a category from categoryLabel at max + 10 with icon folder', async () => {
    await postScenario('c1', { category: 'geology', categoryLabel: 'Геологія' }).expect(201);
    const { rows } = await pool.query(`SELECT label, icon, sort_order, is_visible FROM categories WHERE slug = 'geology'`);
    assert.deepEqual(rows, [{ label: 'Геологія', icon: 'folder', sort_order: 40, is_visible: true }]);
  });

  await t.test('a second new slug appends after the first', async () => {
    await postScenario('c2', { category: 'optics', categoryLabel: 'Оптика' }).expect(201);
    const { rows } = await pool.query(`SELECT sort_order FROM categories WHERE slug = 'optics'`);
    assert.equal(rows[0].sort_order, 50);
  });

  await t.test('a known slug with another label keeps the stored label everywhere', async () => {
    await postScenario('c3', { category: 'physics', categoryLabel: 'Інша назва' }).expect(201);
    const { rows } = await pool.query(`SELECT label FROM categories WHERE slug = 'physics'`);
    assert.equal(rows[0].label, 'Фізика');
    const res = await request(app).get('/api/catalog/c3').expect(200);
    assert.equal(res.body.categoryLabel, 'Фізика');
    const list = await request(app).get('/api/catalog').expect(200);
    assert.equal(list.body.categories.find(c => c.category === 'physics').categoryLabel, 'Фізика');
  });

  await t.test('PUT to an unknown slug creates the category; without categoryLabel the slug is the label', async () => {
    await request(app).put('/api/catalog/c3').set(AUTH).send({ category: 'zoology' }).expect(200);
    const { rows } = await pool.query(`SELECT label, sort_order FROM categories WHERE slug = 'zoology'`);
    assert.deepEqual(rows, [{ label: 'zoology', sort_order: 60 }]);
  });

  await t.test('PUT to a known slug does not touch its label', async () => {
    await request(app).put('/api/catalog/c3').set(AUTH).send({ category: 'geology', categoryLabel: 'Інакше' }).expect(200);
    const { rows } = await pool.query(`SELECT label FROM categories WHERE slug = 'geology'`);
    assert.equal(rows[0].label, 'Геологія');
  });

  await t.test('a PUT for a missing scenario 404s and creates no category', async () => {
    await request(app).put('/api/catalog/ghost').set(AUTH).send({ category: 'phantom' }).expect(404);
    const { rowCount } = await pool.query(`SELECT 1 FROM categories WHERE slug = 'phantom'`);
    assert.equal(rowCount, 0);
  });

  await t.test('a duplicate POST (409) leaves no stray category behind', async () => {
    await postScenario('c1', { category: 'stray', categoryLabel: 'Зайва' }).expect(409);
    const { rowCount } = await pool.query(`SELECT 1 FROM categories WHERE slug = 'stray'`);
    assert.equal(rowCount, 0);
  });

  await t.test('non-string category / categoryLabel on PUT -> 400', async () => {
    await request(app).put('/api/catalog/c3').set(AUTH).send({ category: { a: 1 } }).expect(400);
    await request(app).put('/api/catalog/c3').set(AUTH).send({ category: '' }).expect(400);
    await request(app).put('/api/catalog/c3').set(AUTH).send({ categoryLabel: 5 }).expect(400);
  });

  await t.test('stored features that is not an array reads as []', async () => {
    await pool.query(`UPDATE scenarios SET features = '{"icon":"x"}'::jsonb WHERE id = 'c1'`);
    await pool.query(`UPDATE scenarios SET features = '"text"'::jsonb WHERE id = 'c2'`);
    for (const id of ['c1', 'c2']) {
      assert.deepEqual((await request(app).get(`/api/catalog/${id}`).expect(200)).body.features, []);
    }
    const list = await request(app).get('/api/catalog').expect(200);
    assert.ok(list.body.scenarios.every(s => Array.isArray(s.features)));
    const admin = await request(app).get('/api/admin/scenarios').set(AUTH).expect(200);
    assert.deepEqual(admin.body.scenarios.find(s => s.id === 'c1').features, []);
  });

  await t.test('a slug with no category row still lists its scenarios, with the scenario label and no chip', async () => {
    await pool.query(
      `INSERT INTO scenarios (id, title, category, category_label, status) VALUES ('orphan', 'Без рядка', 'norow', 'Без категорії', 'published')`);
    const list = await request(app).get('/api/catalog?category=norow').expect(200);
    assert.deepEqual(ids(list), ['orphan']);
    assert.equal(list.body.scenarios[0].categoryLabel, 'Без категорії');
    assert.ok(!list.body.categories.some(c => c.category === 'norow'));
  });
});
