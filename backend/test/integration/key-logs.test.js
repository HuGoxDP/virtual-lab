// backend/test/integration/key-logs.test.js
//
// B6 (DW-6.3): no key ever reaches a log. A full key life cycle — issue, sign in,
// create, upload, rotate, revoke, a failed authentication — runs with every
// `console.*` captured, and neither a token nor the SHA-256 the database stores
// may appear in what was written. The log lines themselves are still produced
// and still forwarded, so this is a capture, not a silencing.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

// storage.js reads ARCHIVE_ROOT at load, so it is set before server.js is required.
const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-kl-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { createKey, sha256Hex } = require('../helpers/keys');
const { validArchive } = require('../helpers/fixtures');

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

let available = false;
let moderator;

/** Every `console.*` call, forwarded to the real one and kept as text. */
function captureConsole() {
  const saved = {};
  const lines = [];
  for (const channel of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[channel] = console[channel];
    console[channel] = (...args) => {
      lines.push(args.map(a => (typeof a === 'string' ? a : String(a?.message ?? a))).join(' '));
      saved[channel].apply(console, args);
    };
  }
  return { lines, restore: () => Object.assign(console, saved) };
}

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
  moderator = await createKey(pool, 'moderator', 'Log Watcher');
});

test.beforeEach(() => failedAuth.reset());

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

test('B6.3 a whole key life cycle logs no token and no hash', async t => {
  if (skipUnlessDb(t)) return;

  const capture = captureConsole();
  let issued, rotated, scenarioId;

  try {
    // 1. Issue: the one moment the token exists in clear.
    const created = await request(app).post('/api/keys').set(BOOTSTRAP)
      .send({ label: 'Вчитель', role: 'author' }).expect(201);
    issued = created.body.token;
    assert.match(issued, /^vlk_[A-Za-z0-9_-]{43}$/, 'the token is the vlk_ format');

    const teacher = { Authorization: `Bearer ${issued}` };

    // 2. Use it: sign in, create, upload.
    await request(app).get('/api/auth/me').set(teacher).expect(200);
    const created2 = await request(app).post('/api/catalog').set(teacher)
      .send({ id: 'kl-scenario', title: 'Журнал', category: 'biology' }).expect(201);
    scenarioId = created2.body.id;
    await request(app).post(`/api/scenarios/${scenarioId}/archive`).set(teacher)
      .attach('archive', validArchive(), 'scenario.zip').expect(201);

    // 3. Rotate: a second token, and the scenarios move to it.
    const replaced = await request(app).post(`/api/keys/${created.body.id}/rotate`)
      .set(moderator.auth).expect(201);
    rotated = replaced.body.token;
    assert.notEqual(rotated, issued);

    // 4. The old key is now refused (a failed authentication), the new one works.
    await request(app).get('/api/auth/me').set(teacher).expect(403);
    await request(app).get('/api/auth/me').set({ Authorization: `Bearer ${rotated}` }).expect(200);

    // 5. Revoke, and try again.
    await request(app).post(`/api/keys/${replaced.body.id}/revoke`).set(BOOTSTRAP).expect(200);
    await request(app).get('/api/auth/me').set({ Authorization: `Bearer ${rotated}` }).expect(403);

    // 6. A wrong token: the failed-auth path.
    await request(app).get('/api/auth/me')
      .set({ Authorization: `Bearer vlk_${'x'.repeat(43)}` }).expect(403);
  } finally {
    capture.restore();
  }

  await t.test('the log has lines from the cycle', () => {
    assert.ok(capture.lines.length > 0, 'the run did log something to check');
  });

  await t.test('neither token appears in the log', () => {
    for (const [name, token] of [['the issued token', issued], ['its replacement', rotated]]) {
      assert.ok(!capture.lines.some(line => line.includes(token)), `${name} was logged`);
    }
  });

  await t.test('no stored hash appears in the log either', () => {
    // The database keeps SHA-256 of the token; a log line that prints the digest
    // hands an attacker the lookup key, so neither form may be written.
    for (const token of [issued, rotated]) {
      const digest = sha256Hex(token);
      assert.ok(!capture.lines.some(line => line.includes(digest)), `the hash of a token was logged`);
    }
  });

  await t.test('the admin token is not logged either', () => {
    assert.ok(!capture.lines.some(line => line.includes(process.env.ADMIN_TOKEN)),
      'the bootstrap token was logged');
  });

  await t.test('what the database stores is exactly the hashes', async () => {
    // The other half of the invariant: no clear token in the table either.
    const { rows } = await pool.query('SELECT label, token_hash FROM publish_keys ORDER BY id');
    assert.deepEqual(rows.map(r => r.token_hash).sort(),
      [sha256Hex(issued), sha256Hex(rotated), sha256Hex(moderator.token)].sort());
  });
});
