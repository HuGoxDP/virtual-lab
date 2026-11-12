// backend/test/integration/bola-sweep.test.js
//
// B6 (DW-6.2): an author who is not the owner of a scenario gets 403 or 404 on
// every `:id` route that touches it — never a 2xx. The enumeration comes from
// `helpers/routes.js`, which walks `app._router.stack`, so a route added later
// is swept automatically: the only escape is the public-read allow-list, and a
// new route that is neither on it nor refusing fails this test.
//
// The allow-list is the contract: a route listed here answers an anonymous
// caller, and the sweep skips it. Anything else must refuse author B.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const { idRoutes, PUBLIC_READ_ALLOWLIST } = require('../helpers/routes');

let available = false;
let authorA, authorB;
const victim = 'bola-victim';

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  await truncateAll(pool);
  const { createKey } = require('../helpers/keys');
  authorA = await createKey(pool, 'author', 'Bola Owner');
  authorB = await createKey(pool, 'author', 'Bola Stranger');
  await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, 'Жертва', '', 'bio', 'Біологія', 'published', $2)`,
    [victim, authorA.id]
  );
  const { addCurrentVersion } = require('../helpers/db');
  await addCurrentVersion(pool, victim, 'sha-bola', 1000);
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

/** A minimal, well-formed body per route, so a refusal is about rights and not about shape. */
const BODIES = {
  '/api/catalog/:id': { title: 'x', description: 'd' },
  '/api/scenarios/:id/archive': null,
  '/api/scenarios/:id/preview': null,
  '/api/scenarios/:id/owner': { keyId: authorB?.id ?? 1 },
  '/api/scenarios/:id/versions/:vid/accept': null,
  '/api/scenarios/:id/versions/:vid/reject': null,
  '/api/scenarios/:id/versions/:vid/restore': null,
  '/api/scenarios/:id/versions/:vid/checks': { checks: {}, manifestVersion: '1.0' },
  '/api/scenarios/:id/versions/:vid/test-run': { status: 'ok' },
  '/api/categories/:slug': { label: 'x' },
  '/api/telemetry/session/:id/end': { event: 'end' },
};

/** Substitutes the scenario's id and a numeric vid for the path's params. */
function fill(path) {
  return path
    .replace(/:id/g, victim)
    .replace(/:vid/g, '1')
    .replace(/:slug/g, victim);
}

test('B6.2 every :id route refuses a non-owner author with 403 or 404', async t => {
  if (skipUnlessDb(t)) return;

  const swept = idRoutes(app).filter(r => !r.methods.some(m => PUBLIC_READ_ALLOWLIST.includes(`${m} ${r.path}`)));
  assert.ok(swept.length >= 20, `the sweep should cover the app's routes, got ${swept.length}`);

  for (const route of swept) {
    for (const method of route.methods) {
      const path = fill(route.path);
      const body = BODIES[route.path] ?? {};
      await t.test(`${method} ${path}`, async () => {
        const res = await request(app)[method.toLowerCase()](path)
          .set(authorB.auth)
          .send(method === 'GET' || method === 'DELETE' || body === null ? undefined : body);
        assert.ok([403, 404].includes(res.status), `${method} ${path} answered ${res.status}`);
      });
    }
  }
});

test('B6.2 the enumeration covers at least what the route files declare', () => {
  // A route added later is enumerated automatically; the number here is the
  // floor this branch starts from, and it is recorded so a fall is noticed.
  assert.ok(idRoutes(app).length >= 26, `only ${idRoutes(app).length} :id routes`);
});
