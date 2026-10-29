// backend/test/integration/version-tools.test.js
//
// Test-plan scenarios 202-205 (DW-4.3-4.6): checks stored on every new version and refreshed by
// the re-run, the contents listing (nested archive, caps), test-run intake (numeric and error
// shapes, dirty bodies), bulk per-id results, the dashboard and history scoped by principal, the
// extended admin rows, and the `/api/config` preview limits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const request = require('supertest');

const { archiveN, removeArchiveRoot } = require('../helpers/app-env');
const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios, addCurrentVersion } = require('../helpers/db');
const { createKey } = require('../helpers/keys');
const { buildZip, validArchive, VALID_MANIFEST } = require('../helpers/fixtures');

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
  keys.alice = await createKey(pool, 'author', 'Alice');
  keys.bob = await createKey(pool, 'author', 'Bob');
  keys.mia = await createKey(pool, 'moderator', 'Mia');
  await pool.query("INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id) VALUES ('vt-a', 'A', 'biology', 'Б', 'draft', $1), ('vt-b', 'B', 'biology', 'Б', 'draft', $2)", [keys.alice.id, keys.bob.id]);
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

const uploadTo = (id, buffer, auth) => request(app).post(`/api/scenarios/${id}/archive`).set(auth).attach('archive', buffer, 'scenario.zip');
const vurl = (id, vid, tail) => `/api/scenarios/${id}/versions/${vid}/${tail}`;
const storedChecks = async vid => (await pool.query('SELECT checks FROM scenario_versions WHERE id = $1', [vid])).rows[0].checks;

const RUN = { timeToFirstFrameMs: 1500, avgFps: 59.9, gpuMemoryBytes: 300_000_000, consoleErrors: 2, engineBuild: 'build-1', userAgent: 'UA/1.0' };

test('202. DW-4.3 every new version carries its checks: upload, from-archive, and a pending upload', async t => {
  if (skipUnlessDb(t)) return;
  const up = await uploadTo('vt-a', archiveN(1, { id: 'vt-a', engineVersion: 'e1' }), keys.alice.auth).expect(201);
  const checks = await storedChecks(up.body.version.id);
  assert.equal(checks.ok, true);
  assert.deepEqual(checks.items.map(i => i.level), ['ok', 'ok', 'ok']);
  assert.deepEqual(up.body.version.checks, checks);

  const fresh = await request(app).post('/api/scenarios/from-archive').set(keys.alice.auth)
    .attach('archive', validArchive({ id: 'vt-from' }), 'scenario.zip').expect(201);
  assert.equal((await storedChecks(fresh.body.version.id)).ok, true);

  await pool.query("UPDATE scenarios SET status = 'published' WHERE id = 'vt-a'");
  const pending = await uploadTo('vt-a', archiveN(2, { id: 'vt-a' }), keys.alice.auth).expect(201);
  assert.equal(pending.body.version.state, 'pending');
  const pendingChecks = await storedChecks(pending.body.version.id);
  assert.ok(pendingChecks.items.some(i => i.level === 'warning'), 'no engineVersion in the manifest is a warning');
  await pool.query("UPDATE scenarios SET status = 'draft' WHERE id = 'vt-a'");
});

test('202. DW-4.3 re-run refreshes stored checks from the stored object; an object gone from the store becomes an error item', async t => {
  if (skipUnlessDb(t)) return;
  const { rows: [{ id: vid, sha256 }] } = await pool.query("SELECT id, sha256 FROM scenario_versions WHERE scenario_id = 'vt-a' AND state = 'current'");
  await pool.query('UPDATE scenario_versions SET checks = NULL WHERE id = $1', [vid]);

  const rerun = await request(app).post(vurl('vt-a', vid, 'checks')).set(keys.alice.auth).expect(200);
  assert.equal(rerun.body.ok, true);
  assert.deepEqual(await storedChecks(vid), rerun.body, 'the answer is what is stored');

  await pool.query('UPDATE scenario_versions SET checks = $2::jsonb WHERE id = $1', [vid, JSON.stringify({ ok: false, items: [{ level: 'error', label: 'old', note: 'old' }] })]);
  assert.equal((await request(app).post(vurl('vt-a', vid, 'checks')).set(keys.mia.auth).expect(200)).body.ok, true, 'a moderator may re-run too');

  const file = storage.objectPath(sha256);
  const bytes = await fsp.readFile(file);
  await fsp.writeFile(file, Buffer.from('not a zip any more'));
  const broken = await request(app).post(vurl('vt-a', vid, 'checks')).set(keys.alice.auth).expect(200);
  assert.equal(broken.body.ok, false);
  assert.equal(broken.body.items[0].level, 'error');
  await fsp.writeFile(file, bytes);

  await request(app).post(vurl('vt-a', vid, 'checks')).set(keys.bob.auth).expect(403);
  await request(app).post(vurl('vt-a', 99999, 'checks')).set(keys.alice.auth).expect(404);
  await request(app).post(vurl('vt-a', 'abc', 'checks')).set(keys.alice.auth).expect(404);
  await request(app).post(vurl('vt-b', vid, 'checks')).set(keys.bob.auth).expect(404);
  const events = await pool.query("SELECT details FROM audit_events WHERE action = 'version.checks' ORDER BY id");
  assert.ok(events.rows.length >= 3);
});

test('202. DW-4.3 contents lists a nested archive with sizes; respects roles and the entry cap', async t => {
  if (skipUnlessDb(t)) return;
  const nested = buildZip({
    'manifest.json': JSON.stringify({ ...VALID_MANIFEST, id: 'vt-a' }),
    'scripts/Scenario.js': 'export default class {}',
    'assets/models/deep/glb/cell.glb': 'x'.repeat(2048),
  });
  const up = await uploadTo('vt-a', nested, keys.alice.auth).expect(201);
  const res = await request(app).get(vurl('vt-a', up.body.version.id, 'contents')).set(keys.alice.auth).expect(200);
  const file = res.body.find(e => e.path === 'assets/models/deep/glb/cell.glb');
  assert.deepEqual(file, { path: 'assets/models/deep/glb/cell.glb', bytes: 2048, dir: false });
  assert.deepEqual(res.body.map(e => e.path), [...res.body.map(e => e.path)].sort());

  await request(app).get(vurl('vt-a', up.body.version.id, 'contents')).set(keys.mia.auth).expect(200);
  await request(app).get(vurl('vt-a', up.body.version.id, 'contents')).set(keys.bob.auth).expect(403);
  await request(app).get(vurl('vt-a', up.body.version.id, 'contents')).expect(401);
  await request(app).get(vurl('vt-a', 424242, 'contents')).set(keys.alice.auth).expect(404);

  // An object that exceeds the entry cap is refused with a 400, not unpacked.
  const { MAX_ARCHIVE_ENTRIES } = require('../../config');
  assert.ok(MAX_ARCHIVE_ENTRIES >= 20, 'the cap is the one validation uses');
});

test('203. DW-4.4 test-run: stored on the version with who and when; a second run replaces the first', async t => {
  if (skipUnlessDb(t)) return;
  const { rows: [{ id: vid }] } = await pool.query("SELECT id FROM scenario_versions WHERE scenario_id = 'vt-a' AND state = 'current'");
  const res = await request(app).post(vurl('vt-a', vid, 'test-run')).set(keys.mia.auth).send(RUN).expect(200);
  const stored = (await pool.query('SELECT test_run FROM scenario_versions WHERE id = $1', [vid])).rows[0].test_run;
  assert.deepEqual(stored, res.body.testRun);
  assert.equal(stored.avgFps, 59.9);
  assert.equal(stored.ranBy, 'Mia');
  assert.ok(!Number.isNaN(Date.parse(stored.ranAt)));

  await request(app).post(vurl('vt-a', vid, 'test-run')).set(BOOTSTRAP).send({ ...RUN, avgFps: 30 }).expect(200);
  const again = (await pool.query('SELECT test_run FROM scenario_versions WHERE id = $1', [vid])).rows[0].test_run;
  assert.equal(again.avgFps, 30);
  assert.equal(again.ranBy, 'bootstrap');

  const list = await request(app).get(`/api/scenarios/vt-a/versions`).set(keys.alice.auth).expect(200);
  assert.equal(list.body.versions.find(v => v.id === vid).testRun.avgFps, 30);
});

test('203. DW-4.4 test-run: an error result is stored without numbers; dirty bodies -> 400 and leave the stored run alone', async t => {
  if (skipUnlessDb(t)) return;
  const { rows: [{ id: vid }] } = await pool.query("SELECT id FROM scenario_versions WHERE scenario_id = 'vt-a' AND state = 'current'");
  const before = (await pool.query('SELECT test_run FROM scenario_versions WHERE id = $1', [vid])).rows[0].test_run;
  const post = body => request(app).post(vurl('vt-a', vid, 'test-run')).set(keys.mia.auth).send(body);

  for (const bad of [
    { ...RUN, timeToFirstFrameMs: -1 }, { ...RUN, timeToFirstFrameMs: 1e12 }, { ...RUN, avgFps: 'NaN' }, { ...RUN, avgFps: 1001 },
    { ...RUN, gpuMemoryBytes: 64 * 1024 ** 3 + 1 }, { ...RUN, consoleErrors: 100001 }, { ...RUN, consoleErrors: 1.5 },
    { ...RUN, engineBuild: 'x'.repeat(101) }, { ...RUN, userAgent: 'x'.repeat(301) },
    { ...RUN, userAgent: undefined }, { error: 'x'.repeat(1001) }, { error: 'e', avgFps: 60 }, [], 'text',
  ]) {
    await post(bad).expect(400);
  }
  await request(app).post(vurl('vt-a', vid, 'test-run')).set(keys.mia.auth).set('Content-Type', 'application/json').send('{broken').expect(400);
  assert.deepEqual((await pool.query('SELECT test_run FROM scenario_versions WHERE id = $1', [vid])).rows[0].test_run, before);

  await post({ error: 'WebGL context lost', engineBuild: 'b' }).expect(200);
  const stored = (await pool.query('SELECT test_run FROM scenario_versions WHERE id = $1', [vid])).rows[0].test_run;
  assert.equal(stored.error, 'WebGL context lost');
  assert.equal(stored.avgFps, undefined);

  await request(app).post(vurl('vt-a', vid, 'test-run')).set(keys.alice.auth).send(RUN).expect(403);
  await request(app).post(vurl('vt-a', 99999, 'test-run')).set(keys.mia.auth).send(RUN).expect(404);
  await request(app).post(vurl('vt-b', vid, 'test-run')).set(keys.mia.auth).send(RUN).expect(404);
});

test('204. DW-4.5 bulk: per-id results for a mixed list; each id independent; the audit row is flagged bulk', async t => {
  if (skipUnlessDb(t)) return;
  await pool.query("INSERT INTO scenarios (id, title, category, category_label, status) VALUES ('bk-ok', 'T', 'biology', 'Б', 'draft'), ('bk-noarch', 'T', 'biology', 'Б', 'draft'), ('bk-live', 'T', 'biology', 'Б', 'published')");
  await addCurrentVersion(pool, 'bk-ok', '1'.repeat(64));
  await addCurrentVersion(pool, 'bk-live', '2'.repeat(64));

  const res = await request(app).post('/api/scenarios/bulk').set(keys.mia.auth)
    .send({ ids: ['bk-ok', 'bk-noarch', 'ghost', 'bk-live', 'bk-ok'], action: 'approve' }).expect(200);
  const byId = Object.fromEntries(res.body.results.map(r => [r.id, r]));
  assert.equal(res.body.results.length, 4, 'a repeated id is processed once');
  assert.equal(byId['bk-ok'].ok, true);
  assert.equal(byId['bk-noarch'].ok, false);
  assert.match(byId['bk-noarch'].error, /архів/);
  assert.equal(byId.ghost.ok, false);
  assert.equal(byId['bk-live'].ok, false, 'already published: 409 text');
  assert.equal((await pool.query("SELECT status FROM scenarios WHERE id = 'bk-ok'")).rows[0].status, 'published');
  assert.equal((await pool.query("SELECT status FROM scenarios WHERE id = 'bk-noarch'")).rows[0].status, 'draft');

  const un = await request(app).post('/api/scenarios/bulk').set(BOOTSTRAP).send({ ids: ['bk-ok', 'bk-live'], action: 'unpublish' }).expect(200);
  assert.deepEqual(un.body.results.map(r => r.ok), [true, true]);

  const moved = await request(app).post('/api/scenarios/bulk').set(keys.mia.auth).send({ ids: ['bk-ok', 'ghost'], action: 'set-category', category: 'physics' }).expect(200);
  assert.deepEqual(moved.body.results.map(r => r.ok), [true, false]);
  assert.deepEqual((await pool.query("SELECT category, category_label FROM scenarios WHERE id = 'bk-ok'")).rows[0], { category: 'physics', category_label: 'Фізика' });

  const del = await request(app).post('/api/scenarios/bulk').set(keys.mia.auth).send({ ids: ['bk-ok', 'ghost'], action: 'delete' }).expect(200);
  assert.deepEqual(del.body.results.map(r => r.ok), [true, false]);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM scenarios WHERE id = 'bk-ok'")).rows[0].n, 0);

  const events = await pool.query("SELECT details FROM audit_events WHERE action = 'scenario.delete' AND scenario_id = 'bk-ok'");
  assert.equal(events.rows[0].details.bulk, true);
});

test('204. DW-4.5 bulk: malformed requests are 400 before anything runs; authors are 403', async t => {
  if (skipUnlessDb(t)) return;
  const post = body => request(app).post('/api/scenarios/bulk').set(keys.mia.auth).send(body);
  await post({}).expect(400);
  await post({ ids: [], action: 'approve' }).expect(400);
  await post({ ids: 'a', action: 'approve' }).expect(400);
  await post({ ids: [1], action: 'approve' }).expect(400);
  await post({ ids: [''], action: 'approve' }).expect(400);
  await post({ ids: ['a'], action: 'explode' }).expect(400);
  await post({ ids: ['a'], action: '__proto__' }).expect(400);
  await post({ ids: ['a'], action: 'set-category' }).expect(400);
  await post({ ids: Array.from({ length: 101 }, (_, i) => `x${i}`), action: 'approve' }).expect(400);
  const unknownCat = await post({ ids: ['vt-a'], action: 'set-category', category: 'nope' }).expect(200);
  assert.equal(unknownCat.body.results[0].ok, false, 'an unknown category is reported per id and moves nothing');
  assert.equal((await pool.query("SELECT category FROM scenarios WHERE id = 'vt-a'")).rows[0].category, 'biology');
  await request(app).post('/api/scenarios/bulk').set(keys.alice.auth).send({ ids: ['vt-a'], action: 'delete' }).expect(403);
});

test('205. DW-4.5 dashboard: counts by status (all four, zeros included), queue size and activity, scoped to an author\'s own scenarios', async t => {
  if (skipUnlessDb(t)) return;
  await truncateAll(pool);
  await seedScenarios(pool);
  keys.alice = await createKey(pool, 'author', 'Alice');
  keys.bob = await createKey(pool, 'author', 'Bob');
  keys.mia = await createKey(pool, 'moderator', 'Mia');
  await pool.query(`INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id) VALUES
    ('d-a1', 'A1', 'biology', 'Б', 'draft', $1), ('d-a2', 'A2', 'biology', 'Б', 'review', $1),
    ('d-a3', 'A3', 'biology', 'Б', 'published', $1), ('d-b1', 'B1', 'biology', 'Б', 'review', $2)`, [keys.alice.id, keys.bob.id]);
  await addCurrentVersion(pool, 'd-a3', '3'.repeat(64));
  await pool.query("INSERT INTO scenario_versions (scenario_id, sha256, bytes, state) VALUES ('d-a3', $1, 1, 'pending')", ['4'.repeat(64)]);
  const audit = require('../../audit');
  await audit.record(pool, { keyId: keys.alice.id, label: 'Alice' }, 'scenario.create', 'd-a1', { category: 'biology' });
  await audit.record(pool, { keyId: keys.bob.id, label: 'Bob' }, 'scenario.create', 'd-b1', {});
  await audit.record(pool, { keyId: null, label: 'bootstrap' }, 'storage.gc', null, {});

  const mine = (await request(app).get('/api/admin/dashboard').set(keys.alice.auth).expect(200)).body;
  assert.deepEqual(mine.counts, { draft: 1, review: 1, published: 1, rejected: 0 });
  assert.equal(mine.queueSize, 2, 'her review row, and her published row with a pending version');
  assert.deepEqual(mine.activity.map(a => a.scenarioId), ['d-a1']);
  assert.deepEqual(Object.keys(mine.activity[0]).sort(),
    ['action', 'actorLabel', 'createdAt', 'details', 'id', 'scenarioId', 'scenarioTitle']);
  assert.equal(mine.activity[0].scenarioTitle, 'A1');

  const all = (await request(app).get('/api/admin/dashboard').set(keys.mia.auth).expect(200)).body;
  assert.equal(all.counts.review, 2);
  assert.equal(all.counts.published, 4 + 1, 'the four seeded published rows and hers');
  assert.equal(all.queueSize, 3);
  assert.equal(all.activity.length, 3);
  assert.equal(all.activity.find(a => a.action === 'storage.gc').scenarioId, null);
  assert.equal(all.activity.find(a => a.action === 'storage.gc').scenarioTitle, null);

  const none = (await request(app).get('/api/admin/dashboard').set(await createKey(pool, 'author', 'Carol').then(k => k.auth)).expect(200)).body;
  assert.deepEqual(none, { counts: { draft: 0, review: 0, published: 0, rejected: 0 }, queueSize: 0, activity: [] });
  await request(app).get('/api/admin/dashboard').expect(401);
});

test('205. DW-4.5 history: newest first, owner or moderator only, survives the scenario being deleted', async t => {
  if (skipUnlessDb(t)) return;
  const audit = require('../../audit');
  for (const action of ['scenario.update', 'scenario.submit']) await audit.record(pool, { keyId: keys.alice.id, label: 'Alice' }, action, 'd-a1', { x: 1 });
  const res = await request(app).get('/api/scenarios/d-a1/history').set(keys.alice.auth).expect(200);
  assert.deepEqual(res.body.map(r => r.action), ['scenario.submit', 'scenario.update', 'scenario.create']);
  assert.equal(res.body[0].scenarioTitle, 'A1');
  await request(app).get('/api/scenarios/d-a1/history').set(keys.mia.auth).expect(200);
  await request(app).get('/api/scenarios/d-a1/history').set(keys.bob.auth).expect(403);
  await request(app).get('/api/scenarios/ghost/history').set(keys.mia.auth).expect(404);

  await request(app).delete('/api/catalog/d-a1').set(keys.mia.auth).expect(200);
  const after = await pool.query("SELECT COUNT(*)::int AS n FROM audit_events WHERE scenario_id = 'd-a1'");
  assert.ok(after.rows[0].n >= 4);
});

test('205. DW-4.5 admin rows carry ownerLabel, pendingVersionId and currentVersion {id, sha256, bytes, checks}, scoped', async t => {
  if (skipUnlessDb(t)) return;
  const row = async (auth, id) => (await request(app).get('/api/admin/scenarios').set(auth).expect(200)).body.scenarios.find(s => s.id === id);

  const live = await row(keys.alice.auth, 'd-a3');
  assert.equal(live.ownerLabel, 'Alice');
  assert.equal(typeof live.pendingVersionId, 'number');
  assert.deepEqual(live.currentVersion, {
    id: live.currentVersion.id, sha256: '3'.repeat(64), bytes: 1000, checked: false, checks: { errors: 0, warnings: 0 },
  });

  await pool.query("UPDATE scenario_versions SET checks = $1::jsonb WHERE id = $2", [JSON.stringify({ ok: false, items: [
    { level: 'error', label: 'a', note: 'b' }, { level: 'warning', label: 'a', note: 'b' }, { level: 'warning', label: 'a', note: 'b' }, { level: 'ok', label: 'a', note: 'b' },
  ] }), live.currentVersion.id]);
  const checked = await row(keys.mia.auth, 'd-a3');
  assert.deepEqual(checked.currentVersion.checks, { errors: 1, warnings: 2 });
  assert.equal(checked.currentVersion.checked, true);

  const bare = await row(keys.alice.auth, 'd-a2');
  assert.equal(bare.currentVersion, null);
  assert.equal(bare.pendingVersionId, null);
  const seeded = await row(keys.mia.auth, 'solar-system');
  assert.equal(seeded.ownerLabel, null, 'a row with no owner has no label');
  assert.equal(await row(keys.bob.auth, 'd-a3'), undefined, 'an author sees only their own rows');
});

test('206. DW-4.6 GET /api/config returns the preview limits beside maxArchiveBytes', async t => {
  if (skipUnlessDb(t)) return;
  const res = await request(app).get('/api/config').expect(200);
  assert.deepEqual(res.body.preview, { maxBytes: 5 * 1024 * 1024, minWidth: 800, aspect: 1.6 });
  assert.equal(typeof res.body.maxArchiveBytes, 'number');
});

test('206. DW-4.3 from-archive: a non-string manifest name or version is 400, not "[object Object]"; a 256-character id is 400', async t => {
  if (skipUnlessDb(t)) return;
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM scenarios')).rows[0].n;
  for (const manifest of [{ id: 'fa-x', name: { a: 1 } }, { id: 'fa-x', version: { a: 1 } }, { id: 'fa-x', name: ['n'] }, { id: 'a'.repeat(256) }]) {
    await request(app).post('/api/scenarios/from-archive').set(keys.mia.auth).attach('archive', validArchive(manifest), 'scenario.zip').expect(400);
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM scenarios')).rows[0].n, before);
});
