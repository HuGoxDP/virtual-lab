// backend/test/integration/version-preview.test.js
//
// Test-plan scenario 191 (DW-3.5): GET /api/catalog/:id?version=<sha256> - the public
// projection with one version's archive, for a draft preview. A published scenario's versions
// are public; any other status needs its owner or a moderator (also while in review); everyone
// else gets the same 404 as for an unknown hash. Never cached.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { app, pool } = require('../../server');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { createKey, revokeKey } = require('../helpers/keys');

let available = false;
const keys = {};

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
  keys.owner = await createKey(pool, 'author', 'Alice');
  keys.other = await createKey(pool, 'author', 'Bob');
  keys.moderator = await createKey(pool, 'moderator', 'Mia');
  keys.revoked = await createKey(pool, 'author', 'Rita');
  await revokeKey(pool, keys.revoked.id);
});

test.beforeEach(() => failedAuth.reset());

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

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const CALLERS = {
  anonymous: () => ({}),
  garbage: () => ({ Authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` }),
  revoked: () => keys.revoked.auth,
  other: () => keys.other.auth,
  owner: () => keys.owner.auth,
  moderator: () => keys.moderator.auth,
  bootstrap: () => BOOTSTRAP,
};

let counter = 0;
const sha = n => String(n).padStart(64, 'd');

/** A scenario with a current and a pending version; returns ids and hashes. */
async function makeScenario(status) {
  const id = `pv-${++counter}`;
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id, manifest_url)
    VALUES ($1, 'Preview me', 'biology', 'Біологія', $2, $3, '/a/${id}.json')`, [id, status, keys.owner.id]);
  const out = { id, current: sha(counter * 2), pending: sha(counter * 2 + 1) };
  await pool.query(`
    INSERT INTO scenario_versions (scenario_id, sha256, bytes, state)
    VALUES ($1, $2, 4096, 'current'), ($1, $3, 8192, 'pending')`, [id, out.current, out.pending]);
  await pool.query('UPDATE scenarios SET archive_sha256 = $2, archive_bytes = 4096, scenario_url = $3 WHERE id = $1',
    [id, out.current, `/scenarios/${out.current}.zip`]);
  return out;
}

const preview = (id, version, as = 'anonymous') =>
  request(app).get(`/api/catalog/${id}`).query({ version }).set(CALLERS[as]());

test('191. a published scenario\'s versions are public, pending ones included (DW-3.5)', async t => {
  if (skipUnlessDb(t)) return;
  const s = await makeScenario('published');

  await t.test('the current version: 200 for an anonymous caller, with that archive and no-store', async () => {
    const res = await preview(s.id, s.current).expect(200);
    assert.equal(res.body.id, s.id);
    assert.equal(res.body.title, 'Preview me');
    assert.equal(res.body.scenarioUrl, `/scenarios/${s.current}.zip`);
    assert.equal(res.body.archiveBytes, 4096);
    assert.match(res.get('Cache-Control'), /no-store/);
  });

  await t.test('the pending version plays its own archive, not the live one', async () => {
    const res = await preview(s.id, s.pending).expect(200);
    assert.equal(res.body.scenarioUrl, `/scenarios/${s.pending}.zip`);
    assert.equal(res.body.archiveBytes, 8192);
  });

  await t.test('the projection keeps the public shape; a preview plays the ZIP, never the streaming manifest', async () => {
    const res = await preview(s.id, s.pending).expect(200);
    for (const field of ['id', 'title', 'description', 'fullDescription', 'category', 'categoryLabel', 'imageUrl',
      'scenarioUrl', 'version', 'author', 'uploadDate', 'archiveBytes', 'updatedAt', 'features', 'related']) {
      assert.ok(field in res.body, field);
    }
    assert.equal(res.body.manifestUrl, null);
    assert.deepEqual(res.body.related, []);
    assert.ok(!('status' in res.body) && !('ownerKeyId' in res.body), 'nothing admin-only leaks');
  });

  await t.test('an uppercase hash is the same hash', async () => {
    await preview(s.id, s.current.toUpperCase()).expect(200);
  });

  await t.test('a stale session token on a public page does not break it', async () => {
    await preview(s.id, s.current, 'garbage').expect(200);
    await preview(s.id, s.current, 'revoked').expect(200);
  });
});

for (const status of ['draft', 'review', 'rejected']) {
  test(`191. a ${status} scenario's versions: owner and moderators only (DW-3.5)`, async t => {
    if (skipUnlessDb(t)) return;
    const s = await makeScenario(status);

    const want = { anonymous: 404, garbage: 404, revoked: 404, other: 404, owner: 200, moderator: 200, bootstrap: 200 };
    for (const [as, status] of Object.entries(want)) {
      await t.test(`${as} -> ${status}`, async () => {
        for (const version of [s.current, s.pending]) {
          const res = await preview(s.id, version, as).expect(status);
          assert.match(res.get('Cache-Control'), /no-store/);
          if (status === 200) assert.equal(res.body.scenarioUrl, `/scenarios/${version}.zip`);
        }
      });
    }

    await t.test('the public by-id route still does not show it, owner or not', async () => {
      await request(app).get(`/api/catalog/${s.id}`).set(keys.owner.auth).expect(404);
      await request(app).get(`/api/catalog/${s.id}`).set(keys.moderator.auth).expect(404);
    });
  });
}

test('191. ?version= must be exactly 64 hex characters, else 400 (DW-3.5)', async t => {
  if (skipUnlessDb(t)) return;
  const s = await makeScenario('published');

  const bad = {
    '63 characters': s.current.slice(1),
    '65 characters': `${s.current}0`,
    'non-hex': `${s.current.slice(0, 63)}g`,
    'empty': '',
    'with a space': ` ${s.current.slice(1)}`,
    'a path': '../../etc/passwd',
  };
  for (const [name, version] of Object.entries(bad)) {
    await t.test(name, async () => {
      const res = await preview(s.id, version).expect(400);
      assert.match(res.get('Cache-Control'), /no-store/);
    });
  }

  await t.test('repeated parameter (version[]=a&version[]=b) -> 400', async () => {
    await request(app).get(`/api/catalog/${s.id}?version=${s.current}&version=${s.pending}`).expect(400);
  });

  await t.test('400 comes before any lookup: an unknown scenario with a bad hash is still 400', async () => {
    await preview('pv-nope', 'abc').expect(400);
  });
});

test('191. a hash that is not one of this scenario\'s versions is 404 (DW-3.5)', async t => {
  if (skipUnlessDb(t)) return;
  const mine = await makeScenario('published');
  const theirs = await makeScenario('published');

  await t.test('another scenario\'s version', async () => {
    const res = await preview(mine.id, theirs.current).expect(404);
    assert.match(res.get('Cache-Control'), /no-store/);
  });

  await t.test('an unknown but well-formed hash', async () => {
    await preview(mine.id, 'e'.repeat(64)).expect(404);
  });

  await t.test('an unknown scenario', async () => {
    await preview('pv-nope', mine.current).expect(404);
  });

  await t.test('a deleted (rejected) pending version is gone', async () => {
    await pool.query("DELETE FROM scenario_versions WHERE scenario_id = $1 AND state = 'pending'", [mine.id]);
    await preview(mine.id, mine.pending).expect(404);
  });
});

test('191. a wrong credential on this route counts against the address, like anywhere else (DW-3.5)', async t => {
  if (skipUnlessDb(t)) return;
  const s = await makeScenario('draft');
  const limit = Number(process.env.AUTH_FAILURES_PER_WINDOW || 30);

  let last;
  for (let i = 0; i <= limit; i++) last = await preview(s.id, s.current, 'garbage');
  assert.equal(last.status, 429, `the ${limit + 1}th wrong token is refused outright`);
  assert.ok(last.get('Retry-After'));

  await t.test('a valid key is still served from that address', async () => {
    await preview(s.id, s.current, 'owner').expect(200);
  });
});
