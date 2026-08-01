// backend/test/integration/catalog.test.js
//
// Covers test-plan scenarios 1–16 (catalog read) and 87 (publish round-trip).
// Runs against a real Postgres: the queries use ILIKE ... ESCAPE and a
// COUNT over the same predicate, neither of which a mock would exercise.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { isAvailable, prepareSchema, truncateAll, seedScenarios, PUBLISHED_COUNT } = require('../helpers/db');

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

/** Skips the whole file with an explicit reason rather than failing silently. */
function skipUnlessDb(t) {
  if (!available) {
    t.skip('no database reachable — set DB_HOST/DB_NAME to run integration tests');
    return true;
  }
  return false;
}

test('GET /api/catalog returns only published scenarios', async t => {
  if (skipUnlessDb(t)) return;

  const res = await request(app).get('/api/catalog').expect(200);

  await t.test('total counts published rows only', () => {
    assert.equal(res.body.total, PUBLISHED_COUNT);
  });

  await t.test('no unpublished row leaks into the payload', () => {
    const ids = res.body.scenarios.map(s => s.id);
    assert.ok(!ids.includes('hidden-one'));
    assert.ok(!ids.includes('drive-legacy'));
  });

  await t.test('carries the distinct published categories', () => {
    const keys = res.body.categories.map(c => c.category).sort();
    // physics exists only on unpublished rows, so it must not appear.
    assert.deepEqual(keys, ['astronomy', 'biology']);
  });
});

test('paging is stable and disjoint', async t => {
  if (skipUnlessDb(t)) return;

  const page1 = await request(app).get('/api/catalog?limit=2&offset=0').expect(200);
  const page2 = await request(app).get('/api/catalog?limit=2&offset=2').expect(200);

  await t.test('pages do not overlap', () => {
    const a = page1.body.scenarios.map(s => s.id);
    const b = page2.body.scenarios.map(s => s.id);
    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    assert.deepEqual(a.filter(id => b.includes(id)), []);
  });

  await t.test('together they cover every published row', () => {
    const all = [...page1.body.scenarios, ...page2.body.scenarios].map(s => s.id).sort();
    assert.equal(all.length, PUBLISHED_COUNT);
    assert.equal(new Set(all).size, PUBLISHED_COUNT);
  });

  await t.test('ordering is deterministic across repeated calls', async () => {
    // Two seed rows share created_at on purpose; without the id tiebreaker a
    // row could appear on both pages or on neither.
    const repeat = await request(app).get('/api/catalog?limit=2&offset=0').expect(200);
    assert.deepEqual(
      repeat.body.scenarios.map(s => s.id),
      page1.body.scenarios.map(s => s.id)
    );
  });

  await t.test('offset beyond the end returns an empty page, not an error', async () => {
    const res = await request(app).get('/api/catalog?limit=10&offset=999').expect(200);
    assert.deepEqual(res.body.scenarios, []);
    assert.equal(res.body.total, PUBLISHED_COUNT);
  });
});

test('limit is clamped', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('caps an oversized request at 100', async () => {
    const res = await request(app).get('/api/catalog?limit=5000').expect(200);
    assert.equal(res.body.limit, 100);
  });

  await t.test('falls back to the default for junk values', async () => {
    for (const value of ['0', '-1', 'abc']) {
      const res = await request(app).get(`/api/catalog?limit=${value}`).expect(200);
      assert.equal(res.body.limit, 24, `limit=${value}`);
    }
  });
});

test('category filtering', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('narrows the result set and the total', async () => {
    const res = await request(app).get('/api/catalog?category=astronomy').expect(200);
    assert.equal(res.body.total, 1);
    assert.deepEqual(res.body.scenarios.map(s => s.id), ['solar-system']);
  });

  await t.test('does not narrow the category chips', async () => {
    // Chips describe the whole catalog; narrowing them would make the filter
    // impossible to undo from the UI.
    const res = await request(app).get('/api/catalog?category=astronomy').expect(200);
    assert.equal(res.body.categories.length, 2);
  });

  await t.test('"all" means no filter', async () => {
    const res = await request(app).get('/api/catalog?category=all').expect(200);
    assert.equal(res.body.total, PUBLISHED_COUNT);
  });

  await t.test('an unknown category yields nothing', async () => {
    const res = await request(app).get('/api/catalog?category=nope').expect(200);
    assert.equal(res.body.total, 0);
  });
});

test('search', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('matches the title case-insensitively', async () => {
    const res = await request(app).get('/api/catalog?q=сонячна').expect(200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.scenarios[0].id, 'solar-system');
  });

  await t.test('matches the description too', async () => {
    const res = await request(app).get('/api/catalog?q=органели').expect(200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.scenarios[0].id, 'cell-biology');
  });

  await t.test('whitespace-only query behaves as no filter', async () => {
    const res = await request(app).get('/api/catalog?q=%20%20').expect(200);
    assert.equal(res.body.total, PUBLISHED_COUNT);
  });

  await t.test('a miss returns zero', async () => {
    const res = await request(app).get('/api/catalog?q=zzzznope').expect(200);
    assert.equal(res.body.total, 0);
  });

  await t.test('ILIKE wildcards are treated as literal text', async () => {
    // Regression: unescaped, `%` matched every row and `_` matched any char.
    for (const wildcard of ['%', '_', '%%']) {
      const res = await request(app)
        .get(`/api/catalog?q=${encodeURIComponent(wildcard)}`)
        .expect(200);
      assert.equal(res.body.total, 0, `q=${wildcard} must not match everything`);
    }
  });

  await t.test('a backslash does not break the ESCAPE clause', async () => {
    const res = await request(app).get('/api/catalog?q=%5C').expect(200);
    assert.equal(res.body.total, 0);
  });
});

test('GET /api/catalog/:id', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('returns a published scenario', async () => {
    const res = await request(app).get('/api/catalog/solar-system').expect(200);
    assert.equal(res.body.title, 'Сонячна Система');
    assert.equal(res.body.scenarioUrl, '/scenarios/aaa.zip');
  });

  await t.test('hides an unpublished scenario behind 404', async () => {
    await request(app).get('/api/catalog/hidden-one').expect(404);
  });

  await t.test('404s an unknown id', async () => {
    await request(app).get('/api/catalog/does-not-exist').expect(404);
  });
});

test('ids needing URL encoding resolve correctly', async t => {
  if (skipUnlessDb(t)) return;

  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, is_published)
    VALUES ('with space & pct%', 'Awkward id', 'test', 'Test', true)
  `);

  try {
    await t.test('spaces, ampersands and percent signs survive the round trip', async () => {
      const res = await request(app)
        .get(`/api/catalog/${encodeURIComponent('with space & pct%')}`)
        .expect(200);
      assert.equal(res.body.title, 'Awkward id');
    });
  } finally {
    await pool.query(`DELETE FROM scenarios WHERE id = 'with space & pct%'`);
  }
});
