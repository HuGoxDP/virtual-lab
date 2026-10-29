// backend/test/integration/versions-routes.test.js
//
// Test-plan scenario 190 (DW-3.4): the version routes - list, accept, reject, restore,
// delete - by role, with `:vid` ownership; a pending version's accept, reject and the
// owner's retract; restore of an archived one; the delete rules; unpublish keeping a pending row.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { removeArchiveRoot } = require('../helpers/app-env');
const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth } = require('../../rate-limits');
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

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const CALLERS = {
  anonymous: () => ({}),
  unknown: () => ({ Authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` }),
  owner: () => keys.owner.auth,
  other: () => keys.other.auth,
  moderator: () => keys.moderator.auth,
  bootstrap: () => BOOTSTRAP,
};

let counter = 0;
const shaOf = n => String(n).padStart(64, 'c');

/**
 * A fresh scenario owned by Alice with versions `{ current, pending, archived }` (each
 * optional) and the row pointing at the current one. Returns `{ id, ids: {state: versionId} }`.
 */
async function makeScenario(status, versions = { current: true, pending: true, archived: true }) {
  const id = `vr-${++counter}`;
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id)
    VALUES ($1, 'T', 'biology', 'Біологія', $2, $3)`, [id, status, keys.owner.id]);
  const ids = {};
  let n = counter * 10;
  for (const state of ['archived', 'current', 'pending']) {
    if (!versions[state]) continue;
    const sha = shaOf(++n);
    const { rows } = await pool.query(`
      INSERT INTO scenario_versions (scenario_id, sha256, bytes, state, uploaded_by_key_id)
      VALUES ($1, $2, 1000, $3, $4) RETURNING id`, [id, sha, state, keys.owner.id]);
    ids[state] = rows[0].id;
    ids[`${state}Sha`] = sha;
    if (state === 'current') {
      await pool.query('UPDATE scenarios SET archive_sha256 = $2, archive_bytes = 1000, scenario_url = $3 WHERE id = $1',
        [id, sha, `/scenarios/${sha}.zip`]);
    }
  }
  return { id, ids };
}

const call = (method, path, as) => request(app)[method](path).set(CALLERS[as]());
const versionRows = async id => (await pool.query(
  'SELECT id, state FROM scenario_versions WHERE scenario_id = $1 ORDER BY id', [id])).rows;
const stateById = async vid => (await pool.query('SELECT state FROM scenario_versions WHERE id = $1', [vid])).rows[0]?.state;
const rowOf = async id => (await pool.query('SELECT * FROM scenarios WHERE id = $1', [id])).rows[0];
const auditActions = async id => (await pool.query(
  'SELECT action FROM audit_events WHERE scenario_id = $1 ORDER BY id', [id])).rows.map(r => r.action);

test('190. GET versions: the owner and moderators, newest first, with what the UI shows (DW-3.4)', async t => {
  if (skipUnlessDb(t)) return;
  const { id, ids } = await makeScenario('published');

  await t.test('the owner and every moderator get 200', async () => {
    for (const as of ['owner', 'moderator', 'bootstrap']) await call('get', `/api/scenarios/${id}/versions`, as).expect(200);
  });

  await t.test('another author is 403, an anonymous caller 401, an unknown key 403', async () => {
    await call('get', `/api/scenarios/${id}/versions`, 'other').expect(403);
    await call('get', `/api/scenarios/${id}/versions`, 'anonymous').expect(401);
    await call('get', `/api/scenarios/${id}/versions`, 'unknown').expect(403);
  });

  await t.test('an unknown scenario is 404', async () => {
    await call('get', '/api/scenarios/vr-nope/versions', 'moderator').expect(404);
  });

  await t.test('the shape: state, sha256, url, bytes, uploader label, newest first', async () => {
    const res = await call('get', `/api/scenarios/${id}/versions`, 'owner').expect(200);
    const list = res.body.versions;
    assert.deepEqual(list.map(v => v.id), [ids.pending, ids.current, ids.archived].sort((a, b) => b - a));
    const current = list.find(v => v.state === 'current');
    assert.equal(current.sha256, ids.currentSha);
    assert.equal(current.url, `/scenarios/${ids.currentSha}.zip`);
    assert.equal(current.bytes, 1000);
    assert.equal(current.uploadedByLabel, 'Alice');
    assert.ok('checks' in current && 'testRun' in current && 'uploadedAt' in current);
  });
});

test('190. accept: a pending version becomes current, the old current is archived (DW-3.4)', async t => {
  if (skipUnlessDb(t)) return;
  const { id, ids } = await makeScenario('published');

  await call('post', `/api/scenarios/${id}/versions/${ids.pending}/accept`, 'moderator').expect(200);

  assert.equal(await stateById(ids.pending), 'current');
  assert.equal(await stateById(ids.current), 'archived');
  assert.equal(await stateById(ids.archived), 'archived');
  const row = await rowOf(id);
  assert.equal(row.archive_sha256, ids.pendingSha, 'the catalog row now points at the accepted archive');
  assert.equal(row.scenario_url, `/scenarios/${ids.pendingSha}.zip`);
  assert.deepEqual(await auditActions(id), ['version.accept']);

  await t.test('accepting it again is a 409 (it is current now)', async () => {
    await call('post', `/api/scenarios/${id}/versions/${ids.pending}/accept`, 'moderator').expect(409);
  });

  await t.test('only a pending version can be accepted: archived -> 409', async () => {
    await call('post', `/api/scenarios/${id}/versions/${ids.archived}/accept`, 'moderator').expect(409);
  });
});

test('190. reject: a pending version\'s row is deleted, its object is left to GC (DW-3.4)', async t => {
  if (skipUnlessDb(t)) return;
  const { id, ids } = await makeScenario('published');

  await call('post', `/api/scenarios/${id}/versions/${ids.pending}/reject`, 'moderator').expect(200);
  assert.equal(await stateById(ids.pending), undefined, 'the row is gone, not marked');
  assert.equal(await stateById(ids.current), 'current');
  assert.equal((await rowOf(id)).archive_sha256, ids.currentSha);
  assert.deepEqual(await auditActions(id), ['version.reject']);

  await t.test('a current or archived version cannot be rejected', async () => {
    await call('post', `/api/scenarios/${id}/versions/${ids.current}/reject`, 'moderator').expect(409);
    await call('post', `/api/scenarios/${id}/versions/${ids.archived}/reject`, 'moderator').expect(409);
  });
});

test('190. restore: an archived version becomes current, the current one is archived (DW-3.4)', async t => {
  if (skipUnlessDb(t)) return;
  const { id, ids } = await makeScenario('published');

  await call('post', `/api/scenarios/${id}/versions/${ids.archived}/restore`, 'moderator').expect(200);
  assert.equal(await stateById(ids.archived), 'current');
  assert.equal(await stateById(ids.current), 'archived');
  assert.equal(await stateById(ids.pending), 'pending', 'a pending proposal is not touched');
  const row = await rowOf(id);
  assert.equal(row.archive_sha256, ids.archivedSha);
  assert.equal(row.scenario_url, `/scenarios/${ids.archivedSha}.zip`);
  assert.deepEqual(await auditActions(id), ['version.restore']);

  await t.test('only an archived version can be restored: current and pending -> 409', async () => {
    await call('post', `/api/scenarios/${id}/versions/${ids.archived}/restore`, 'moderator').expect(409);
    await call('post', `/api/scenarios/${id}/versions/${ids.pending}/restore`, 'moderator').expect(409);
  });

  await t.test('exactly one current version remains after any sequence', async () => {
    await call('post', `/api/scenarios/${id}/versions/${ids.current}/restore`, 'moderator').expect(200);
    const rows = await versionRows(id);
    assert.equal(rows.filter(r => r.state === 'current').length, 1);
  });
});

test('190. DELETE: archived by a moderator, pending by its owner or a moderator, never the current one (DW-3.4)', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('the current version -> 409 for the owner and for a moderator', async () => {
    const { id, ids } = await makeScenario('published');
    await call('delete', `/api/scenarios/${id}/versions/${ids.current}`, 'moderator').expect(409);
    await call('delete', `/api/scenarios/${id}/versions/${ids.current}`, 'owner').expect(409);
    assert.equal(await stateById(ids.current), 'current');
  });

  await t.test('an archived version: a moderator deletes it, the owning author may not', async () => {
    const { id, ids } = await makeScenario('published');
    await call('delete', `/api/scenarios/${id}/versions/${ids.archived}`, 'owner').expect(403);
    assert.equal(await stateById(ids.archived), 'archived');
    await call('delete', `/api/scenarios/${id}/versions/${ids.archived}`, 'moderator').expect(200);
    assert.equal(await stateById(ids.archived), undefined);
    assert.deepEqual(await auditActions(id), ['version.delete']);
  });

  await t.test('a pending version: the owner retracts it; the row is deleted', async () => {
    const { id, ids } = await makeScenario('published');
    await call('delete', `/api/scenarios/${id}/versions/${ids.pending}`, 'owner').expect(200);
    assert.equal(await stateById(ids.pending), undefined);
    assert.equal((await rowOf(id)).archive_sha256, ids.currentSha);
  });

  await t.test('another author cannot retract it; an anonymous caller neither', async () => {
    const { id, ids } = await makeScenario('published');
    await call('delete', `/api/scenarios/${id}/versions/${ids.pending}`, 'other').expect(403);
    await call('delete', `/api/scenarios/${id}/versions/${ids.pending}`, 'anonymous').expect(401);
    assert.equal(await stateById(ids.pending), 'pending');
  });

  await t.test('a moderator may delete a pending version too', async () => {
    const { id, ids } = await makeScenario('published');
    await call('delete', `/api/scenarios/${id}/versions/${ids.pending}`, 'moderator').expect(200);
  });
});

test('190. unpublish keeps a pending version pending (DW-3.4)', async t => {
  if (skipUnlessDb(t)) return;
  const { id, ids } = await makeScenario('published');

  await call('post', `/api/scenarios/${id}/unpublish`, 'moderator').expect(200);
  assert.equal((await rowOf(id)).status, 'draft');
  assert.equal(await stateById(ids.pending), 'pending');
  assert.equal(await stateById(ids.current), 'current');
});

test('190. :vid must belong to :id - anything else is a 404 and changes nothing (DW-3.4)', async t => {
  if (skipUnlessDb(t)) return;
  const mine = await makeScenario('published');
  const theirs = await makeScenario('published');

  const routes = [
    ['post', vid => `/api/scenarios/${mine.id}/versions/${vid}/accept`],
    ['post', vid => `/api/scenarios/${mine.id}/versions/${vid}/reject`],
    ['post', vid => `/api/scenarios/${mine.id}/versions/${vid}/restore`],
    ['delete', vid => `/api/scenarios/${mine.id}/versions/${vid}`],
  ];

  for (const [method, path] of routes) {
    for (const state of ['pending', 'archived', 'current']) {
      await t.test(`${method.toUpperCase()} ${path('<vid>').split('/').slice(-2).join('/')} with another scenario's ${state} version -> 404`, async () => {
        await call(method, path(theirs.ids[state]), 'moderator').expect(404);
        assert.equal(await stateById(theirs.ids[state]), state);
      });
    }
    await t.test(`${method} with a malformed, huge or missing version id -> 404`, async () => {
      for (const vid of ['abc', '0', '-1', '1.5', '99999999999999999999', '2147483648', '999999999']) {
        await call(method, path(vid), 'moderator').expect(404);
      }
    });
  }

  await t.test('and an unknown scenario -> 404', async () => {
    await call('post', `/api/scenarios/vr-nope/versions/${mine.ids.pending}/accept`, 'moderator').expect(404);
    await call('delete', `/api/scenarios/vr-nope/versions/${mine.ids.pending}`, 'moderator').expect(404);
  });
});

test('190. version routes x role: who may do what (DW-3.4)', async t => {
  if (skipUnlessDb(t)) return;

  /** action -> [which version, callers who get 200]; everyone else is the status in DENIED. */
  const MODERATORS = ['moderator', 'bootstrap'];
  const DENIED = { anonymous: 401, unknown: 403, owner: 403, other: 403 };
  const cases = [
    { name: 'accept', state: 'pending', send: (id, v, as) => call('post', `/api/scenarios/${id}/versions/${v}/accept`, as), allowed: MODERATORS },
    { name: 'reject', state: 'pending', send: (id, v, as) => call('post', `/api/scenarios/${id}/versions/${v}/reject`, as), allowed: MODERATORS },
    { name: 'restore', state: 'archived', send: (id, v, as) => call('post', `/api/scenarios/${id}/versions/${v}/restore`, as), allowed: MODERATORS },
    { name: 'delete archived', state: 'archived', send: (id, v, as) => call('delete', `/api/scenarios/${id}/versions/${v}`, as), allowed: MODERATORS },
    { name: 'delete pending', state: 'pending', send: (id, v, as) => call('delete', `/api/scenarios/${id}/versions/${v}`, as), allowed: ['owner', ...MODERATORS],
      denied: { anonymous: 401, unknown: 403, other: 403 } },
  ];

  for (const c of cases) {
    for (const as of Object.keys(CALLERS)) {
      const ok = c.allowed.includes(as);
      const want = ok ? 200 : (c.denied ?? DENIED)[as];
      await t.test(`${c.name} as ${as} -> ${want}`, async () => {
        const { id, ids } = await makeScenario('published');
        await c.send(id, ids[c.state], as).expect(want);
        if (!ok) assert.equal(await stateById(ids[c.state]), c.state, 'a denied call changes nothing');
      });
    }
  }
});

test('190. accept and restore are single transactions (DW-3.4)', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('two accepts of different pending... only one pending exists, so racing accepts leave one current', async () => {
    const { id, ids } = await makeScenario('published');
    const results = await Promise.all([
      call('post', `/api/scenarios/${id}/versions/${ids.pending}/accept`, 'moderator'),
      call('post', `/api/scenarios/${id}/versions/${ids.pending}/accept`, 'bootstrap'),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const rows = await versionRows(id);
    assert.equal(rows.filter(r => r.state === 'current').length, 1);
    assert.equal(rows.filter(r => r.state === 'pending').length, 0);
    assert.equal((await rowOf(id)).archive_sha256, ids.pendingSha);
  });

  await t.test('a restore racing an accept never leaves two current versions or a stale row', async () => {
    const { id, ids } = await makeScenario('published');
    await Promise.all([
      call('post', `/api/scenarios/${id}/versions/${ids.pending}/accept`, 'moderator'),
      call('post', `/api/scenarios/${id}/versions/${ids.archived}/restore`, 'bootstrap'),
    ]);
    const rows = await versionRows(id);
    const current = rows.filter(r => r.state === 'current');
    assert.equal(current.length, 1);
    const sha = (await pool.query('SELECT sha256 FROM scenario_versions WHERE id = $1', [current[0].id])).rows[0].sha256;
    assert.equal((await rowOf(id)).archive_sha256, sha, 'the row mirrors the one current version');
  });
});
