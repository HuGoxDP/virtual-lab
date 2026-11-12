// backend/test/integration/preview-limits.test.js
//
// B6 phase 4 (DW-4.3): the cover upload has its own counter, so covers cannot eat
// the archive budget and archives cannot eat it. The limit runs before the body is
// stored, so a 429 leaves the temp dir and the preview store untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-itest-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;
// A small limit: three uploads, the fourth is refused.
process.env.AUTHOR_PREVIEWS_PER_HOUR = '3';

const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth, authorPreviews } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { createKey } = require('../helpers/keys');
const { png } = require('../helpers/images');

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

let available = false;
const keys = {};

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
  keys.author = await createKey(pool, 'author', 'Cover Author');
  keys.moderator = await createKey(pool, 'moderator', 'Cover Moderator');
  await pool.query("UPDATE scenarios SET owner_key_id = $1 WHERE id = 'cell-biology'", [keys.author.id]);
});

test.beforeEach(() => { failedAuth.reset(); authorPreviews.reset(); });

test.after(async () => {
  if (available) await truncateAll(pool);
  await pool.end();
  await fsp.rm(ARCHIVE_ROOT, { recursive: true, force: true });
  await fsp.rm(storage.PREVIEW_ROOT, { recursive: true, force: true });
  delete process.env.AUTHOR_PREVIEWS_PER_HOUR;
});

function skipUnlessDb(t) {
  if (!available) {
    t.skip('no database reachable — set DB_HOST/DB_NAME to run integration tests');
    return true;
  }
  return false;
}

const upload = (auth = keys.author.auth) =>
  request(app).post('/api/scenarios/cell-biology/preview').set(auth)
    .attach('preview', png(800, 500), { filename: 'cover.png', contentType: 'image/png' });

test('B6.4 DW-4.3: the third preview upload passes, the fourth is 429 before anything is stored', async t => {
  if (skipUnlessDb(t)) return;

  for (let i = 1; i <= 3; i++) await upload().expect(200);

  const before = await fsp.readdir(storage.previews.objectsDir);
  const tmpBefore = await fsp.readdir(storage.previews.tmpDir);
  const over = await upload().expect(429);
  assert.ok(Number(over.headers['retry-after']) > 0);

  await t.test('nothing new was stored', async () => {
    assert.deepEqual(await fsp.readdir(storage.previews.objectsDir), before);
    assert.deepEqual(await fsp.readdir(storage.previews.tmpDir), tmpBefore);
  });

  await t.test('a moderator is not limited', async () => {
    for (let i = 1; i <= 4; i++) await upload(keys.moderator.auth).expect(200);
    await upload(BOOTSTRAP).expect(200);
  });

  await t.test('the archive budget is untouched', async () => {
    const { validArchive } = require('../helpers/fixtures');
    // The archive route needs the review status the fixture does not have; a 200 or a
    // 409 both prove the counter did not refuse it (a 429 would be the bug).
    const res = await request(app).post('/api/scenarios/cell-biology/archive').set(keys.author.auth)
      .attach('archive', validArchive(), 'scenario.zip');
    assert.ok([200, 201, 409].includes(res.status), `archive status ${res.status}`);
  });

  await t.test('a delete is not counted', async () => {
    authorPreviews.reset();
    await request(app).delete('/api/scenarios/cell-biology/preview').set(keys.author.auth).expect(200);
    for (let i = 1; i <= 3; i++) await upload().expect(200);
  });
});
