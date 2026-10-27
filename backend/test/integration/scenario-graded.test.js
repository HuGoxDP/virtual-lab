// backend/test/integration/scenario-graded.test.js
//
// Phase 5 (LTI), DW-5.3: `scenarios.graded` follows the uploaded archive's manifest. Only an explicit
// `graded: true` marks a scenario graded; the default (column and upload without the key) is false.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

// storage.js reads ARCHIVE_ROOT at load, so it is set before server.js is required.
const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-itest-graded-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const { app, pool } = require('../../server');
const storage = require('../../storage');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { validArchive } = require('../helpers/fixtures');

const AUTH = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

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

const upload = (id, buffer) => request(app).post(`/api/scenarios/${id}/archive`).set(AUTH).attach('archive', buffer, 'scenario.zip');
const gradedOf = async id => (await pool.query('SELECT graded FROM scenarios WHERE id = $1', [id])).rows[0].graded;

test('DW_5_3 a scenario that was never uploaded to is not graded (column default)', async t => {
  if (!available) return t.skip('no database reachable');

  assert.equal(await gradedOf('solar-system'), false);
});

test('DW_5_3 an uploaded archive whose manifest says graded: true sets graded true', async t => {
  if (!available) return t.skip('no database reachable');

  await upload('solar-system', validArchive({ graded: true })).expect(201);

  assert.equal(await gradedOf('solar-system'), true);
});

test('DW_5_3 an uploaded archive without the key sets graded false, also over a previously graded row', async t => {
  if (!available) return t.skip('no database reachable');

  await upload('cell-biology', validArchive({ graded: true })).expect(201);
  assert.equal(await gradedOf('cell-biology'), true);

  await upload('cell-biology', validArchive()).expect(201);
  assert.equal(await gradedOf('cell-biology'), false);
});

test('graded: false in the manifest sets graded false', async t => {
  if (!available) return t.skip('no database reachable');

  await upload('tie-a', validArchive({ graded: false })).expect(201);

  assert.equal(await gradedOf('tie-a'), false);
});

test('a manifest whose graded is not a boolean is rejected (400) and the row keeps its value', async t => {
  if (!available) return t.skip('no database reachable');
  await upload('tie-b', validArchive({ graded: true })).expect(201);

  for (const graded of ['true', 1, null, {}]) {
    const res = await upload('tie-b', validArchive({ graded }));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /graded/);
  }
  assert.equal(await gradedOf('tie-b'), true);
});
