// backend/test/integration/route-table.test.js
//
// Test-plan scenarios 179 (the route table, DW-2.3) and 180 (dirty
// Authorization headers, DW-2.3).
//
// Every admin route x every kind of caller, with the expected status stated
// once per route as "who may" — everyone else is 401 (nothing presented), 403
// (unknown / revoked key) or 403 (valid but not allowed). A denied call must
// also leave the state it would have changed untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

// storage.js reads ARCHIVE_ROOT at load, so it is set before server.js is required.
const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-itest-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios, addCurrentVersion } = require('../helpers/db');
const { validArchive } = require('../helpers/fixtures');
const { createKey, revokeKey } = require('../helpers/keys');

const BOOTSTRAP_TOKEN = process.env.ADMIN_TOKEN;

let available = false;
const keys = {};
/** The key a revoke test targets; replaced before every table cell. */
let spare;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);

  keys.authorA = await createKey(pool, 'author', 'Alice');
  keys.authorB = await createKey(pool, 'author', 'Bob');
  keys.moderator = await createKey(pool, 'moderator', 'Mia');
  keys.revoked = await createKey(pool, 'author', 'Rita');
  await revokeKey(pool, keys.revoked.id);
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

/** The Authorization header each kind of caller sends. */
const CALLERS = {
  anonymous: () => ({}),
  unknown:   () => ({ Authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` }),
  revoked:   () => keys.revoked.auth,
  authorA:   () => keys.authorA.auth,
  authorB:   () => keys.authorB.auth,
  moderator: () => keys.moderator.auth,
  bootstrap: () => ({ Authorization: `Bearer ${BOOTSTRAP_TOKEN}` }),
};

const MODERATORS = ['moderator', 'bootstrap'];
const ANY_PRINCIPAL = ['authorA', 'authorB', 'moderator', 'bootstrap'];

/** What a denied caller gets, by caller. */
const DENIED = { anonymous: 401, unknown: 403, revoked: 403, authorA: 403, authorB: 403, moderator: 403, bootstrap: 403 };

let counter = 0;

/** Version ids of the fixtures below, refreshed by `resetFixtures`. */
let fx = {};

/**
 * Rows every cell starts from: `rt-own` is Alice's draft with a current archive; `rt-rev` her
 * scenario in review; `rt-pub` her published one with a pending and an archived version beside
 * the current; `rt-del` is a throwaway.
 */
async function resetFixtures() {
  await pool.query("DELETE FROM scenarios WHERE id LIKE 'rt-%'");
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id)
    VALUES ('rt-own', 'Own', 'biology', 'Біологія', 'draft', $1),
           ('rt-rev', 'In review', 'biology', 'Біологія', 'review', $1),
           ('rt-pub', 'Live', 'biology', 'Біологія', 'published', $1),
           ('rt-del', 'Delete me', 'biology', 'Біологія', 'draft', NULL)
  `, [keys.authorA.id]);
  for (const id of ['rt-own', 'rt-rev']) await addCurrentVersion(pool, id, id === 'rt-own' ? 'a'.repeat(64) : 'b'.repeat(64));
  await addCurrentVersion(pool, 'rt-pub', 'c'.repeat(64));
  const { rows } = await pool.query(`
    INSERT INTO scenario_versions (scenario_id, sha256, bytes, state)
    VALUES ('rt-pub', $1, 1, 'pending'), ('rt-pub', $2, 1, 'archived') RETURNING id, state`, ['d'.repeat(64), 'e'.repeat(64)]);
  fx = Object.fromEntries(rows.map(r => [r.state, r.id]));
}

const count = async sql => (await pool.query(sql)).rows[0].n;

/**
 * One entry per guarded route. `send` issues the call; `ok` is its success
 * status; `allowed` the callers who get it; `state` (optional) reads whatever a
 * denied call must not change.
 */
const ROUTES = [
  {
    name: 'GET /api/admin/scenarios', ok: 200, allowed: ANY_PRINCIPAL,
    send: (r, h) => r.get('/api/admin/scenarios').set(h),
  },
  {
    name: 'POST /api/catalog', ok: 201, allowed: ANY_PRINCIPAL,
    send: (r, h) => r.post('/api/catalog').set(h).send({
      id: `rt-new-${++counter}`, title: 'New', category: 'biology', categoryLabel: 'Біологія',
    }),
    state: () => count('SELECT COUNT(*)::int AS n FROM scenarios'),
  },
  {
    name: 'PUT /api/catalog/rt-own', ok: 200, allowed: ['authorA', ...MODERATORS],
    send: (r, h) => r.put('/api/catalog/rt-own').set(h).send({ title: 'Changed' }),
    state: async () => (await pool.query("SELECT title FROM scenarios WHERE id = 'rt-own'")).rows[0].title,
  },
  {
    name: 'DELETE /api/catalog/rt-del', ok: 200, allowed: MODERATORS,
    send: (r, h) => r.delete('/api/catalog/rt-del').set(h),
    state: () => count("SELECT COUNT(*)::int AS n FROM scenarios WHERE id = 'rt-del'"),
  },
  {
    name: 'POST /api/scenarios/rt-own/archive', ok: 201, allowed: ['authorA', ...MODERATORS],
    send: (r, h) => r.post('/api/scenarios/rt-own/archive').set(h).attach('archive', validArchive(), 'scenario.zip'),
    state: async () => (await pool.query("SELECT archive_sha256 FROM scenarios WHERE id = 'rt-own'")).rows[0].archive_sha256,
  },
  {
    name: 'GET /api/admin/storage', ok: 200, allowed: MODERATORS,
    send: (r, h) => r.get('/api/admin/storage').set(h),
  },
  {
    name: 'POST /api/admin/storage/gc', ok: 200, allowed: MODERATORS,
    send: (r, h) => r.post('/api/admin/storage/gc').set(h).send({}),
  },
  {
    name: 'GET /api/telemetry/summary', ok: 200, allowed: MODERATORS,
    send: (r, h) => r.get('/api/telemetry/summary').set(h),
  },
  {
    name: 'GET /api/keys', ok: 200, allowed: MODERATORS,
    send: (r, h) => r.get('/api/keys').set(h),
  },
  {
    name: 'POST /api/keys', ok: 201, allowed: MODERATORS,
    send: (r, h) => r.post('/api/keys').set(h).send({ label: 'rt-key', role: 'author' }),
    state: () => count('SELECT COUNT(*)::int AS n FROM publish_keys'),
  },
  {
    name: 'POST /api/keys/:id/revoke', ok: 200, allowed: MODERATORS,
    send: (r, h) => r.post(`/api/keys/${spare.id}/revoke`).set(h),
    state: async () => (await pool.query('SELECT revoked_at FROM publish_keys WHERE id = $1', [spare.id])).rows[0].revoked_at,
  },
  {
    name: 'GET /api/auth/me', ok: 200, allowed: ANY_PRINCIPAL,
    send: (r, h) => r.get('/api/auth/me').set(h),
  },
  // ── Phase 3: the workflow and the version history ──
  ...[['submit', 'rt-own', ['authorA', ...MODERATORS]], ['withdraw', 'rt-rev', ['authorA', ...MODERATORS]],
    ['approve', 'rt-own', MODERATORS], ['reject', 'rt-rev', MODERATORS], ['unpublish', 'rt-pub', MODERATORS]]
    .map(([action, id, allowed]) => ({
      name: `POST /api/scenarios/${id}/${action}`, ok: 200, allowed,
      send: (r, h) => r.post(`/api/scenarios/${id}/${action}`).set(h),
      state: async () => (await pool.query('SELECT status FROM scenarios WHERE id = $1', [id])).rows[0].status,
    })),
  {
    name: 'GET /api/scenarios/rt-own/versions', ok: 200, allowed: ['authorA', ...MODERATORS],
    send: (r, h) => r.get('/api/scenarios/rt-own/versions').set(h),
  },
  ...['accept', 'reject'].map(action => ({
    name: `POST /api/scenarios/rt-pub/versions/:vid/${action} (pending)`, ok: 200, allowed: MODERATORS,
    send: (r, h) => r.post(`/api/scenarios/rt-pub/versions/${fx.pending}/${action}`).set(h),
    state: async () => (await pool.query('SELECT state FROM scenario_versions WHERE id = $1', [fx.pending])).rows[0]?.state,
  })),
  {
    name: 'POST /api/scenarios/rt-pub/versions/:vid/restore (archived)', ok: 200, allowed: MODERATORS,
    send: (r, h) => r.post(`/api/scenarios/rt-pub/versions/${fx.archived}/restore`).set(h),
    state: async () => (await pool.query('SELECT state FROM scenario_versions WHERE id = $1', [fx.archived])).rows[0]?.state,
  },
  {
    name: 'DELETE /api/scenarios/rt-pub/versions/:vid (archived)', ok: 200, allowed: MODERATORS,
    send: (r, h) => r.delete(`/api/scenarios/rt-pub/versions/${fx.archived}`).set(h),
    state: async () => (await pool.query('SELECT state FROM scenario_versions WHERE id = $1', [fx.archived])).rows[0]?.state,
  },
  {
    name: 'DELETE /api/scenarios/rt-pub/versions/:vid (pending)', ok: 200, allowed: ['authorA', ...MODERATORS],
    send: (r, h) => r.delete(`/api/scenarios/rt-pub/versions/${fx.pending}`).set(h),
    state: async () => (await pool.query('SELECT state FROM scenario_versions WHERE id = $1', [fx.pending])).rows[0]?.state,
  },
  {
    name: 'POST /api/scenarios/from-archive', ok: 201, allowed: ANY_PRINCIPAL,
    send: (r, h) => r.post('/api/scenarios/from-archive').set(h)
      .attach('archive', validArchive({ id: 'rt-from-archive' }), 'scenario.zip'),
    state: () => count('SELECT COUNT(*)::int AS n FROM scenarios'),
  },
];

test('179. route table: every admin route x every caller (DW-2.3)', async t => {
  if (skipUnlessDb(t)) return;

  for (const route of ROUTES) {
    for (const [caller, header] of Object.entries(CALLERS)) {
      const allowed = route.allowed.includes(caller);
      const expected = allowed ? route.ok : DENIED[caller];

      await t.test(`${route.name} as ${caller} -> ${expected}`, async () => {
        failedAuth.reset();
        authorUploads.reset();
        await resetFixtures();
        // A fresh revoke target for every cell, so a revoke by one caller does not decide the next.
        spare = await createKey(pool, 'author', `spare-${++counter}`);

        const before = route.state && !allowed ? await route.state() : null;
        await route.send(request(app), header()).expect(expected);
        if (route.state && !allowed) assert.deepEqual(await route.state(), before, 'a denied call changed state');
      });
    }
  }
});

test('179. an author sees only their own scenarios; a moderator sees all', async t => {
  if (skipUnlessDb(t)) return;
  failedAuth.reset();
  await resetFixtures();

  const mine = await request(app).get('/api/admin/scenarios').set(keys.authorA.auth).expect(200);
  assert.deepEqual(mine.body.scenarios.map(s => s.id).sort(), ['rt-own', 'rt-pub', 'rt-rev']);
  assert.equal(mine.body.scenarios[0].ownerKeyId, keys.authorA.id);

  const other = await request(app).get('/api/admin/scenarios').set(keys.authorB.auth).expect(200);
  assert.deepEqual(other.body.scenarios, []);

  const all = await request(app).get('/api/admin/scenarios').set(keys.moderator.auth).expect(200);
  assert.ok(all.body.scenarios.length >= 8, 'moderator sees the seeded rows and the fixtures');
});

test('179. public reads stay public beside the guarded table', async t => {
  if (skipUnlessDb(t)) return;
  for (const url of ['/api/catalog', '/api/catalog/solar-system', '/api/config', '/api/health']) {
    await request(app).get(url).expect(200);
  }
});

// ══════════════════════════════════════════════════════
// 180. Dirty Authorization headers
// ══════════════════════════════════════════════════════

/** Sends raw header lines, which supertest cannot (it merges duplicates). */
function rawRequest(server, headerLines) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ port, path: '/api/auth/me', method: 'GET', headers: headerLines }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('180. dirty Authorization headers (DW-2.3)', async t => {
  if (skipUnlessDb(t)) return;
  const valid = keys.moderator.token;

  await t.test('"Bearer " with nothing after it -> 401', async () => {
    failedAuth.reset();
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer ').expect(401);
  });

  await t.test('"Bearer" alone, and a Basic credential -> 401', async () => {
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer').expect(401);
    await request(app).get('/api/auth/me').set('Authorization', 'Basic dXNlcjpwYXNz').expect(401);
  });

  await t.test('a lowercase "bearer" scheme is not accepted -> 401 (the contract is the exact scheme)', async () => {
    await request(app).get('/api/auth/me').set('Authorization', `bearer ${valid}`).expect(401);
  });

  await t.test('two spaces before the token -> 403, never authenticated', async () => {
    failedAuth.reset();
    await request(app).get('/api/auth/me').set('Authorization', `Bearer  ${valid}`).expect(403);
  });

  await t.test('a 10 KB token -> 403, not a crash and not a slow hash', async () => {
    failedAuth.reset();
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${'a'.repeat(10 * 1024)}`).expect(403);
  });

  await t.test('a duplicated header never lets a bad credential through', async () => {
    failedAuth.reset();
    const server = http.createServer(app).listen(0);
    try {
      const bad = 'Bearer not-a-key';
      const good = `Bearer ${valid}`;
      const badFirst = await rawRequest(server, ['Host', 'localhost', 'Authorization', bad, 'Authorization', good]);
      assert.equal(badFirst, 403);
      const goodFirst = await rawRequest(server, ['Host', 'localhost', 'Authorization', good, 'Authorization', bad]);
      assert.ok(goodFirst < 500, `answered ${goodFirst}`);
    } finally {
      server.close();
    }
  });

  await t.test('ADMIN_TOKEN unset: personal keys still work, the bootstrap is off, no 503', async () => {
    failedAuth.reset();
    const saved = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = '';
    try {
      await request(app).get('/api/auth/me').set(keys.moderator.auth).expect(200);
      await request(app).get('/api/admin/scenarios').set(keys.authorA.auth).expect(200);
      await request(app).get('/api/keys').set(keys.moderator.auth).expect(200);
      await request(app).get('/api/auth/me').expect(401);
      await request(app).get('/api/auth/me').set('Authorization', `Bearer ${saved}`).expect(403);
      await request(app).post('/api/catalog').expect(401);
    } finally {
      process.env.ADMIN_TOKEN = saved;
    }
  });
});
