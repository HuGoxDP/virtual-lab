// backend/test/integration/archive-caps.test.js
//
// Test-plan scenario 184, route half (DW-2.6): an upload that breaks a
// validation cap is a 400 at the default caps, stores nothing and leaves no
// temp file. The cap arithmetic itself is in test/unit/archive-caps.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

// storage.js reads ARCHIVE_ROOT at load, so it is set before server.js is required.
const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-itest-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const { app, pool } = require('../../server');
const storage = require('../../storage');
const { MAX_ENTRY_BYTES, MAX_ARCHIVE_ENTRIES } = require('../../config');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const { buildZip, VALID_MANIFEST } = require('../helpers/fixtures');
const { createKey } = require('../helpers/keys');

let available = false;
let alice;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  alice = await createKey(pool, 'author', 'Alice');
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, is_published, owner_key_id)
    VALUES ('cap-1', 'T', 'biology', 'Біологія', false, $1)`, [alice.id]);
});

test.beforeEach(() => {
  failedAuth.reset();
  authorUploads.reset();
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

const pad = bytes => {
  const text = JSON.stringify(VALID_MANIFEST);
  return text + ' '.repeat(bytes - text.length);
};

test('184. an author upload that breaks a cap is a 400 that stores nothing (DW-2.6)', async t => {
  if (skipUnlessDb(t)) return;

  const cases = [
    ['a manifest of MAX_ENTRY_BYTES + 1', /завеликий/,
      () => buildZip({ 'manifest.json': pad(MAX_ENTRY_BYTES + 1), 'scripts/Scenario.js': 'x' })],
    [`${MAX_ARCHIVE_ENTRIES + 1} entries`, /забагато файлів/, () => {
      const filler = {};
      for (let i = 0; i < MAX_ARCHIVE_ENTRIES - 1; i++) filler[`assets/f${i}.txt`] = 'x';
      return buildZip({ 'manifest.json': JSON.stringify(VALID_MANIFEST), 'scripts/Scenario.js': 'x', ...filler });
    }],
  ];

  for (const [name, pattern, build] of cases) {
    await t.test(`${name} -> 400, nothing stored, temp released`, async () => {
      const objectsBefore = (await fsp.readdir(storage.OBJECTS_DIR)).length;
      const res = await request(app).post('/api/scenarios/cap-1/archive').set(alice.auth)
        .attach('archive', build(), 'scenario.zip').expect(400);
      assert.match(res.body.error, pattern);
      assert.equal((await fsp.readdir(storage.OBJECTS_DIR)).length, objectsBefore);
      assert.deepEqual(await fsp.readdir(storage.TMP_DIR), []);
      assert.equal((await pool.query("SELECT archive_sha256 FROM scenarios WHERE id = 'cap-1'")).rows[0].archive_sha256, null);
    });
  }
});
