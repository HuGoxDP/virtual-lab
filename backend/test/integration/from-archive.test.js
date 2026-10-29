// backend/test/integration/from-archive.test.js
//
// Test-plan scenario 192 (DW-3.6): POST /api/scenarios/from-archive creates a draft from a
// ZIP and reports its manifest; a taken id is a 409; an id that is not a slug (it comes from
// untrusted manifest data) and an invalid ZIP are 400s that leave no row, object or temp file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const request = require('supertest');

const { removeArchiveRoot, sha256Of } = require('../helpers/app-env');
const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { validArchive, invalidArchives } = require('../helpers/fixtures');
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

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

const slugArchive = (id, over = {}) => validArchive({ id, name: `Scenario ${id}`, description: 'Опис зі маніфесту', ...over });

const send = (buffer, headers = keys.author.auth, fields = {}) => {
  let req = request(app).post('/api/scenarios/from-archive').set(headers);
  for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
  return buffer ? req.attach('archive', buffer, 'scenario.zip') : req;
};

const rowOf = async id => (await pool.query('SELECT * FROM scenarios WHERE id = $1', [id])).rows[0];
const scenarioCount = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM scenarios')).rows[0].n;
const objectCount = async () => (await fsp.readdir(storage.OBJECTS_DIR)).length;

/** Asserts a refusal left nothing behind: no row, no stored object, no temp file. */
async function assertNothingLeft(before) {
  assert.equal(await scenarioCount(), before.scenarios, 'no row');
  assert.equal(await objectCount(), before.objects, 'no object in the store');
  assert.deepEqual(await fsp.readdir(storage.TMP_DIR), [], 'no temp file');
}
const snapshot = async () => ({ scenarios: await scenarioCount(), objects: await objectCount() });

test('192. a valid ZIP becomes a draft owned by the caller, with its manifest reported (DW-3.6)', async t => {
  if (skipUnlessDb(t)) return;
  const zip = slugArchive('fa-ok', { version: '2.1.0', engineVersion: 'eng-9' });
  const res = await send(zip).expect(201);

  await t.test('the response: scenario, version, manifest, warnings', () => {
    assert.equal(res.body.scenario.id, 'fa-ok');
    assert.equal(res.body.scenario.status, 'draft');
    assert.equal(res.body.scenario.isPublished, false);
    assert.equal(res.body.version.state, 'current');
    assert.equal(res.body.version.sha256, sha256Of(zip));
    assert.deepEqual(res.body.manifest, {
      id: 'fa-ok', name: 'Scenario fa-ok', version: '2.1.0', entryPoint: 'Scenario.js',
      resourceCount: 3, // manifest.json, scripts/Scenario.js, assets/readme.txt
      engineVersion: 'eng-9',
    });
    assert.deepEqual(res.body.warnings, []);
  });

  await t.test('the row: manifest fields, the caller as owner and author, archive attached', async () => {
    const row = await rowOf('fa-ok');
    assert.equal(row.title, 'Scenario fa-ok');
    assert.equal(row.description, 'Опис зі маніфесту');
    assert.equal(row.full_description, 'Опис зі маніфесту');
    assert.equal(row.version, '2.1.0');
    assert.equal(row.owner_key_id, keys.author.id);
    assert.equal(row.author, 'Alice');
    assert.equal(row.status, 'draft');
    assert.equal(row.archive_sha256, sha256Of(zip));
    assert.equal(row.scenario_url, `/scenarios/${sha256Of(zip)}.zip`);
    assert.equal(res.body.scenario.ownerKeyId, keys.author.id);
  });

  await t.test('the category defaults to the first one, and it is not in the public catalog', async () => {
    assert.equal((await rowOf('fa-ok')).category, 'astronomy');
    await request(app).get('/api/catalog/fa-ok').expect(404);
  });

  await t.test('the journal has the create and the archive, in one transaction', async () => {
    const { rows } = await pool.query("SELECT action FROM audit_events WHERE scenario_id = 'fa-ok' ORDER BY id");
    assert.deepEqual(rows.map(r => r.action), ['scenario.create', 'scenario.archive']);
  });

  await t.test('the owner can submit it straight away (it has a current version)', async () => {
    await request(app).post('/api/scenarios/fa-ok/submit').set(keys.author.auth).expect(200);
  });
});

test('192. category: an existing slug is used, an unknown one is a 400 with nothing left (DW-3.6)', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('a given category is used', async () => {
    await send(slugArchive('fa-cat'), keys.author.auth, { category: 'physics' }).expect(201);
    assert.equal((await rowOf('fa-cat')).category, 'physics');
    assert.equal((await rowOf('fa-cat')).category_label, 'Фізика');
  });

  await t.test('an unknown category -> 400', async () => {
    const before = await snapshot();
    await send(slugArchive('fa-cat-bad'), keys.author.auth, { category: 'no-such' }).expect(400);
    await assertNothingLeft(before);
  });

  await t.test('a blank category -> 400', async () => {
    const before = await snapshot();
    await send(slugArchive('fa-cat-blank'), keys.author.auth, { category: '   ' }).expect(400);
    await assertNothingLeft(before);
  });
});

test('192. owner by caller: a moderator key owns it, the bootstrap token leaves it unowned (DW-3.6)', async t => {
  if (skipUnlessDb(t)) return;

  await send(slugArchive('fa-mod'), keys.moderator.auth).expect(201);
  const byKey = await rowOf('fa-mod');
  assert.equal(byKey.owner_key_id, keys.moderator.id);
  assert.equal(byKey.author, 'Mia');

  await send(slugArchive('fa-boot'), BOOTSTRAP).expect(201);
  const boot = await rowOf('fa-boot');
  assert.equal(boot.owner_key_id, null);
  assert.equal(boot.author, null);
});

test('192. a taken id -> 409, and the existing scenario is untouched (DW-3.6)', async t => {
  if (skipUnlessDb(t)) return;
  await send(slugArchive('fa-taken')).expect(201);
  const original = await rowOf('fa-taken');
  const before = await snapshot();

  await t.test('another upload of the same id, other bytes', async () => {
    const res = await send(slugArchive('fa-taken', { name: 'Different' }), keys.moderator.auth).expect(409);
    assert.match(res.body.error, /fa-taken/);
    assert.deepEqual(await rowOf('fa-taken'), original);
    await assertNothingLeft(before);
  });

  await t.test('an id taken by a seeded row', async () => {
    await send(slugArchive('solar-system')).expect(409);
    await assertNothingLeft(before);
  });

  await t.test('two simultaneous creates of one new id: one 201, one 409, one row', async () => {
    const zip = slugArchive('fa-race');
    const results = await Promise.all([send(zip), send(zip, keys.moderator.auth)]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await pool.query("SELECT 1 FROM scenario_versions WHERE scenario_id = 'fa-race'")).rowCount, 1);
    assert.deepEqual(await fsp.readdir(storage.TMP_DIR), []);
  });
});

test('192. a manifest id that is not a catalog slug -> 400 with a hint, never a 500 (DW-3.6)', async t => {
  if (skipUnlessDb(t)) return;

  const bad = {
    '101 characters': 'a'.repeat(101),
    'with a slash': 'my/scenario',
    'with spaces': 'my scenario',
    'reverse-domain': 'template.benchscene1.primitives',
    'uppercase': 'Solar-System',
    'one character': 'a',
    'a leading hyphen': '-solar',
    'a path traversal': '../etc/passwd',
    'a backslash': 'a\\b',
    'unicode': 'сонце-система',
    'a number': 12345,
  };
  for (const [name, id] of Object.entries(bad)) {
    await t.test(`${name} -> 400`, async () => {
      const before = await snapshot();
      const res = await send(slugArchive(id)).expect(400);
      assert.match(res.body.error, /ScenarioCreator/, 'tells the author what to do');
      await assertNothingLeft(before);
    });
  }

  await t.test('a 100-character slug and a 2-character slug are fine', async () => {
    await send(slugArchive('a'.repeat(100))).expect(201);
    await send(slugArchive('b0')).expect(201);
  });

  await t.test('a long hostile id is not echoed back whole', async () => {
    const res = await send(slugArchive('x y'.repeat(500))).expect(400);
    assert.ok(res.body.error.length < 400);
  });
});

test('192. an invalid ZIP -> 400 and no row is left (DW-3.6)', async t => {
  if (skipUnlessDb(t)) return;

  for (const [name, make] of Object.entries(invalidArchives)) {
    await t.test(name, async () => {
      const before = await snapshot();
      await send(make()).expect(400);
      await assertNothingLeft(before);
    });
  }

  await t.test('no file at all -> 400', async () => {
    const before = await snapshot();
    await send(null).expect(400);
    await assertNothingLeft(before);
  });
});

test('192. who may call it: any key, nobody anonymous; authors are rate-limited like uploads (DW-3.6)', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('no credential -> 401, a wrong one -> 403', async () => {
    await send(slugArchive('fa-anon'), {}).expect(401);
    await send(slugArchive('fa-anon'), { Authorization: 'Bearer nope' }).expect(403);
    assert.equal(await rowOf('fa-anon'), undefined);
  });

  await t.test('an author key gets 20 attempts an hour, the 21st is a 429; a moderator is exempt', async () => {
    const carl = await createKey(pool, 'author', 'Carl');
    const junk = invalidArchives.notAZip();
    for (let i = 0; i < 20; i++) await send(junk, carl.auth).expect(400);
    await send(slugArchive('fa-limited'), carl.auth).expect(429);
    assert.equal(await rowOf('fa-limited'), undefined);

    for (let i = 0; i < 21; i++) await send(junk, keys.moderator.auth).expect(400);
  });
});
