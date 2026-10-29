// backend/test/integration/archive-limit.test.js
//
// Covers test-plan scenarios 106–107: GET /api/config and the upload size cap.
// MAX_ARCHIVE_BYTES is read once at load, so it is set before server.js is required.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { validArchive } = require('../helpers/fixtures');

const ARCHIVE = validArchive();
process.env.MAX_ARCHIVE_BYTES = String(ARCHIVE.length);
const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-limit-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const { app, pool } = require('../../server');
const storage = require('../../storage');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');

const AUTH = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const SERVER_DIR = path.join(__dirname, '../..');

let available = false;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
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

/** Runs /api/config in a fresh process with the given env override (or none). */
function configInChild(maxArchiveBytes) {
  const env = { ...process.env };
  delete env.MAX_ARCHIVE_BYTES;
  if (maxArchiveBytes !== undefined) env.MAX_ARCHIVE_BYTES = maxArchiveBytes;
  const script = `
    const request = require('supertest');
    const { app, pool } = require('./server');
    request(app).get('/api/config').then(r => { console.log(JSON.stringify([r.status, r.body])); return pool.end(); });
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: SERVER_DIR, env, encoding: 'utf8' }));
}

test('106. [DW-1.5] GET /api/config', async t => {
  await t.test('defaults to 200 MiB', () => {
    const [status, body] = configInChild(undefined);
    assert.equal(status, 200);
    assert.equal(body.maxArchiveBytes, 209715200);
  });

  await t.test('honours MAX_ARCHIVE_BYTES', () => {
    const [status, body] = configInChild('12345');
    assert.equal(status, 200);
    assert.equal(body.maxArchiveBytes, 12345);
  });

  await t.test('a junk value falls back to the default instead of disabling the cap', () => {
    for (const junk of ['abc', '0', '-5', '1.5']) {
      assert.equal(configInChild(junk)[1].maxArchiveBytes, 209715200, junk);
    }
  });

  await t.test('is public and reflects the limit this process loaded', async () => {
    const res = await request(app).get('/api/config').expect(200);
    assert.equal(res.body.maxArchiveBytes, ARCHIVE.length);
  });
});

test('107. [DW-1.5] upload size cap -> 413, boundary, no temp file left', async t => {
  if (skipUnlessDb(t)) return;

  const tempFiles = () => fsp.readdir(storage.TMP_DIR);
  const upload = buffer => request(app)
    .post('/api/scenarios/solar-system/archive').set(AUTH).attach('archive', buffer, 'scenario.zip');

  await t.test('limit + 1 byte -> 413 with a Ukrainian message and an empty temp dir', async () => {
    const res = await upload(Buffer.concat([ARCHIVE, Buffer.from([0])])).expect(413);
    assert.match(res.body.error, /завеликий/);
    assert.deepEqual(await tempFiles(), []);
  });

  await t.test('a much larger upload -> 413 as well', async () => {
    await upload(Buffer.concat([ARCHIVE, Buffer.alloc(100_000)])).expect(413);
    assert.deepEqual(await tempFiles(), []);
  });

  await t.test('exactly the limit is accepted', async () => {
    const res = await upload(ARCHIVE).expect(201);
    assert.equal(res.body.bytes, ARCHIVE.length);
    assert.deepEqual(await tempFiles(), []);
  });

  await t.test('the oversize attempt stored nothing for the scenario', async () => {
    const before = (await pool.query(`SELECT archive_sha256 FROM scenarios WHERE id = 'solar-system'`)).rows[0];
    await upload(Buffer.concat([ARCHIVE, Buffer.from([1, 2, 3])])).expect(413);
    const after = (await pool.query(`SELECT archive_sha256 FROM scenarios WHERE id = 'solar-system'`)).rows[0];
    assert.deepEqual(after, before);
  });

  await t.test('the size check runs after auth: no token -> 401, not 413', async () => {
    await request(app).post('/api/scenarios/solar-system/archive')
      .attach('archive', Buffer.concat([ARCHIVE, Buffer.alloc(10)]), 'x.zip').expect(401);
  });

  await t.test('another multer failure (unexpected field) -> 400, not 500', async () => {
    await request(app).post('/api/scenarios/solar-system/archive').set(AUTH)
      .attach('wrong', ARCHIVE, 'x.zip').expect(400);
    assert.deepEqual(await tempFiles(), []);
  });
});
