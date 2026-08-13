// backend/test/integration/archives-and-telemetry.test.js
//
// Covers test-plan scenarios 24–25, 33 (proxy addressing), 36–44 (archives)
// and 52–61 (telemetry).

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
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { validArchive, invalidArchives } = require('../helpers/fixtures');

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

function skipUnlessDb(t) {
  if (!available) {
    t.skip('no database reachable — set DB_HOST/DB_NAME to run integration tests');
    return true;
  }
  return false;
}

const tempFiles = () => fsp.readdir(storage.TMP_DIR);
const objectFiles = () => fsp.readdir(storage.OBJECTS_DIR);

// ══════════════════════════════════════════════════════
// ARCHIVES
// ══════════════════════════════════════════════════════

test('archive upload', async t => {
  if (skipUnlessDb(t)) return;

  const buffer = validArchive();
  const expectedHash = crypto.createHash('sha256').update(buffer).digest('hex');

  await t.test('stores the archive and repoints the scenario', async () => {
    const res = await request(app)
      .post('/api/scenarios/solar-system/archive')
      .set(AUTH)
      .attach('archive', buffer, 'scenario.zip')
      .expect(201);

    assert.equal(res.body.sha256, expectedHash);
    assert.equal(res.body.bytes, buffer.length);
    assert.equal(res.body.url, `/scenarios/${expectedHash}.zip`);
    assert.equal(res.body.manifestId, 'test.scenario.valid');
  });

  await t.test('records the manifest id and storage kind in the row', async () => {
    const { rows } = await pool.query(
      'SELECT scenario_url, archive_sha256, archive_bytes, storage_kind, manifest_id FROM scenarios WHERE id = $1',
      ['solar-system']
    );
    assert.equal(rows[0].storage_kind, 'local');
    assert.equal(rows[0].archive_sha256, expectedHash);
    assert.equal(Number(rows[0].archive_bytes), buffer.length);
    assert.equal(rows[0].manifest_id, 'test.scenario.valid');
    assert.equal(rows[0].scenario_url, `/scenarios/${expectedHash}.zip`);
  });

  await t.test('warns that the manifest id differs from the catalog id', async () => {
    const res = await request(app)
      .post('/api/scenarios/cell-biology/archive')
      .set(AUTH)
      .attach('archive', buffer, 'scenario.zip')
      .expect(201);

    assert.equal(res.body.warnings.length, 1);
    assert.match(res.body.warnings[0], /cell-biology/);
  });

  await t.test('identical content deduplicates', async () => {
    const before = (await objectFiles()).length;

    const res = await request(app)
      .post('/api/scenarios/cell-biology/archive')
      .set(AUTH)
      .attach('archive', buffer, 'scenario.zip')
      .expect(201);

    assert.equal(res.body.deduplicated, true);
    assert.equal((await objectFiles()).length, before);
  });

  await t.test('leaves no temp file behind on success', async () => {
    assert.deepEqual(await tempFiles(), []);
  });
});

test('archive upload rejects bad input without leaking temp files', async t => {
  if (skipUnlessDb(t)) return;

  const cases = [
    ['not a ZIP', invalidArchives.notAZip(), /ZIP/],
    ['no manifest', invalidArchives.noManifest(), /manifest\.json/],
    ['invalid JSON', invalidArchives.invalidJson(), /JSON/],
    ['missing fields', invalidArchives.missingFields(), /manifestVersion/],
    ['missing entry point', invalidArchives.missingEntryPoint(), /Scenario\.js/],
  ];

  for (const [label, buffer, pattern] of cases) {
    await t.test(`${label} → 400 with a specific reason`, async () => {
      const objectsBefore = (await objectFiles()).length;

      const res = await request(app)
        .post('/api/scenarios/solar-system/archive')
        .set(AUTH)
        .attach('archive', buffer, 'scenario.zip')
        .expect(400);

      assert.match(res.body.error, pattern);
      assert.equal((await objectFiles()).length, objectsBefore, 'nothing was stored');
      assert.deepEqual(await tempFiles(), [], 'temp file was released');
    });
  }

  await t.test('unknown scenario → 404 and the temp file is still released', async () => {
    // Regression: an early `return` inside the handler's try leaked the upload
    // until cleanup moved into `finally`.
    await request(app)
      .post('/api/scenarios/does-not-exist/archive')
      .set(AUTH)
      .attach('archive', validArchive(), 'scenario.zip')
      .expect(404);

    assert.deepEqual(await tempFiles(), []);
  });

  await t.test('no file at all → 400', async () => {
    await request(app)
      .post('/api/scenarios/solar-system/archive')
      .set(AUTH)
      .expect(400);
  });
});

// ══════════════════════════════════════════════════════
// THE DRIVE PATH IS GONE
// ══════════════════════════════════════════════════════

test('the server no longer fetches archives from anywhere', async t => {
  if (skipUnlessDb(t)) return;

  // These endpoints existed to pull archives off Google Drive: a proxy that
  // followed redirects and scraped Google's HTML confirmation page with
  // regexes, and an admin migration path built on the same code. Every catalog
  // row is served from local storage now, so both were deleted.
  //
  // Asserting they stay gone is the point of this test. The proxy took a URL
  // from the client at one stage and was an open relay for anything on the
  // allowlisted hosts; reintroducing it by accident should fail here.

  await t.test('the download proxy is not routed at all', async () => {
    await request(app).get('/api/proxy-download?id=solar-system').expect(404);
    await request(app)
      .get('/api/proxy-download?url=https://storage.googleapis.com/any/object.zip')
      .expect(404);
  });

  await t.test('the import-from-source endpoint is not routed at all', async () => {
    await request(app)
      .post('/api/scenarios/solar-system/archive/import')
      .set(AUTH)
      .expect(404);
  });

  await t.test('uploading an archive still works', async () => {
    // The replacement path, so the deletion above is not mistaken for a loss of
    // function: archives arrive by upload, not by the server fetching them.
    const res = await request(app)
      .post('/api/scenarios/solar-system/archive')
      .set(AUTH)
      .attach('archive', validArchive(), 'scenario.zip')
      .expect(201);

    assert.equal(res.body.id, 'solar-system');
    assert.match(res.body.url, /^\/scenarios\/[0-9a-f]{64}\.zip$/);
  });
});

// ══════════════════════════════════════════════════════
// TELEMETRY
// ══════════════════════════════════════════════════════

test('telemetry session lifecycle', async t => {
  if (skipUnlessDb(t)) return;

  let sessionId;

  await t.test('starting a session returns an id', async () => {
    const res = await request(app)
      .post('/api/telemetry/session')
      .send({ scenarioId: 'solar-system', clientId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
      .expect(201);

    sessionId = res.body.sessionId;
    assert.ok(sessionId);
  });

  await t.test('ending it records a server-computed duration', async () => {
    await request(app).post(`/api/telemetry/session/${sessionId}/end`).expect(204);

    const { rows } = await pool.query(
      'SELECT ended_at, duration_ms FROM scenario_sessions WHERE id = $1',
      [sessionId]
    );
    assert.ok(rows[0].ended_at);
    assert.ok(rows[0].duration_ms >= 0);
    assert.ok(rows[0].duration_ms < 60_000, 'a fresh session cannot last a minute');
  });

  await t.test('replaying the end call cannot change the duration', async () => {
    const before = await pool.query('SELECT duration_ms FROM scenario_sessions WHERE id = $1', [sessionId]);

    await new Promise(resolve => setTimeout(resolve, 30));
    await request(app).post(`/api/telemetry/session/${sessionId}/end`).expect(204);

    const after = await pool.query('SELECT duration_ms FROM scenario_sessions WHERE id = $1', [sessionId]);
    assert.equal(after.rows[0].duration_ms, before.rows[0].duration_ms);
  });
});

test('telemetry input handling', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('an unknown scenario is refused', async () => {
    await request(app).post('/api/telemetry/session')
      .send({ scenarioId: 'nope' })
      .expect(404);
  });

  await t.test('a missing scenarioId is refused', async () => {
    await request(app).post('/api/telemetry/session').send({}).expect(400);
  });

  await t.test('a malformed clientId is accepted as NULL, not rejected', async () => {
    // Telemetry must never block playback over a bad client id.
    const res = await request(app).post('/api/telemetry/session')
      .send({ scenarioId: 'solar-system', clientId: 'not-a-uuid' })
      .expect(201);

    const { rows } = await pool.query(
      'SELECT client_id FROM scenario_sessions WHERE id = $1',
      [res.body.sessionId]
    );
    assert.equal(rows[0].client_id, null);
  });

  await t.test('a non-numeric session id is refused', async () => {
    await request(app).post('/api/telemetry/session/abc/end').expect(400);
    await request(app).post('/api/telemetry/session/-1/end').expect(400);
  });

  await t.test('ending an unknown session is a silent no-op', async () => {
    await request(app).post('/api/telemetry/session/999999/end').expect(204);
  });
});

test('telemetry survives scenario deletion', async t => {
  if (skipUnlessDb(t)) return;

  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, is_published)
    VALUES ('doomed', 'Doomed', 'test', 'Test', true)
  `);

  await request(app).post('/api/telemetry/session')
    .send({ scenarioId: 'doomed' })
    .expect(201);

  await request(app).delete('/api/catalog/doomed').set(AUTH).expect(200);

  await t.test('the session row outlives the scenario', async () => {
    // No foreign key on purpose: deleting a scenario must not erase the
    // record that it was used.
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM scenario_sessions WHERE scenario_id = $1',
      ['doomed']
    );
    assert.equal(rows[0].count, 1);
  });
});

test('telemetry summary', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('aggregates per scenario for admins', async () => {
    const res = await request(app).get('/api/telemetry/summary').set(AUTH).expect(200);

    const solar = res.body.scenarios.find(s => s.scenarioId === 'solar-system');
    assert.ok(solar, 'solar-system should appear');
    assert.ok(solar.launches >= 1);
    assert.ok(solar.completed >= 1);
    assert.equal(typeof solar.medianDurationMs, 'number');
  });

  await t.test('clamps the days window into 1…365', async () => {
    // Note the deliberate asymmetry: `0` and junk are falsy so they fall back
    // to the 30-day default, while a negative parses fine and is clamped to
    // the minimum. Both land inside the contract.
    const cases = [['7', 7], ['0', 30], ['abc', 30], ['', 30], ['-5', 1], ['9999', 365]];

    for (const [input, expected] of cases) {
      const res = await request(app).get(`/api/telemetry/summary?days=${input}`).set(AUTH).expect(200);
      assert.equal(res.body.days, expected, `days=${input}`);
      assert.ok(res.body.days >= 1 && res.body.days <= 365, `days=${input} out of range`);
    }
  });
});
