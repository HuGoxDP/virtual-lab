// backend/test/integration/migration-008-009.test.js
//
// Test-plan scenario 187 (DW-3.1): migrations 008 (status, moderator note, version history,
// backfill) and 009 (drop `is_published`) apply twice without error; existing rows become
// published/draft with one current version each; the catalog shows exactly the published ones.
//
// The pre-008 database is rebuilt inside a transaction that is rolled back, so the shared
// test schema is untouched when the test ends.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { pool } = require('../../server');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');

const MIGRATIONS = path.join(__dirname, '../../migrations');
const read = name => fsp.readFile(path.join(MIGRATIONS, name), 'utf8');

let available = false;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  await truncateAll(pool);
});

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

const SHA = ch => ch.repeat(64);

/** Rewinds the schema to what 007 left: `is_published` back, no status columns, no versions. */
async function rewindToBefore008(client) {
  await client.query('DROP TABLE scenario_versions');
  await client.query('ALTER TABLE scenarios DROP COLUMN status, DROP COLUMN moderator_note, DROP COLUMN submitted_at');
  await client.query('ALTER TABLE scenarios ADD COLUMN is_published BOOLEAN DEFAULT true');
}

test('187. migrations 008 and 009 backfill and apply twice (DW-3.1)', async t => {
  if (skipUnlessDb(t)) return;
  const [m008, m009] = await Promise.all([read('008_status_and_versions.sql'), read('009_drop_is_published.sql')]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await rewindToBefore008(client);

    // is_published is nullable: TRUE is published, FALSE and NULL are not.
    await client.query(`
      INSERT INTO scenarios (id, title, category, category_label, is_published, archive_sha256, archive_bytes,
                             manifest_id, manifest_version, manifest_engine_version)
      VALUES ('live-zip',  'T', 'x', 'X', true,  '${SHA('a')}', 111, 'live.m',  '1.2.3', 'eng-1'),
             ('live-null-bytes', 'T', 'x', 'X', true, '${SHA('b')}', NULL, NULL, NULL, NULL),
             ('off-zip',   'T', 'x', 'X', false, '${SHA('c')}', 333, 'off.m',   '0.1.0', NULL),
             ('null-zip',  'T', 'x', 'X', NULL,  '${SHA('d')}', 444, NULL, NULL, NULL)`);
    await client.query(`
      INSERT INTO scenarios (id, title, category, category_label, is_published, manifest_url)
      VALUES ('live-stream', 'T', 'x', 'X', true, '/a/live-stream.json'),
             ('off-none',    'T', 'x', 'X', false, NULL)`);

    const state = async () => ({
      statuses: Object.fromEntries((await client.query('SELECT id, status FROM scenarios ORDER BY id')).rows.map(r => [r.id, r.status])),
      versions: (await client.query(
        'SELECT scenario_id, sha256, bytes::int AS bytes, manifest_id, manifest_version, engine_version, state FROM scenario_versions ORDER BY scenario_id'
      )).rows,
      published: (await client.query("SELECT COUNT(*)::int AS n FROM scenarios WHERE status = 'published'")).rows[0].n,
    });

    await t.test('008: statuses come from is_published; every archive becomes one current version', async () => {
      await client.query(m008);
      const after = await state();

      assert.deepEqual(after.statuses, {
        'live-zip': 'published', 'live-null-bytes': 'published', 'live-stream': 'published',
        'off-zip': 'draft', 'null-zip': 'draft', 'off-none': 'draft',
      });
      assert.deepEqual(after.versions.map(v => [v.scenario_id, v.state]), [
        ['live-null-bytes', 'current'], ['live-zip', 'current'], ['null-zip', 'current'], ['off-zip', 'current'],
      ], 'one current version per archived row; the streaming-only and archive-less rows get none');

      const live = after.versions.find(v => v.scenario_id === 'live-zip');
      assert.deepEqual(
        [live.sha256, live.bytes, live.manifest_id, live.manifest_version, live.engine_version],
        [SHA('a'), 111, 'live.m', '1.2.3', 'eng-1'],
        'the version carries the row\'s archive metadata'
      );
      assert.equal(after.versions.find(v => v.scenario_id === 'live-null-bytes').bytes, 0, 'a NULL size becomes 0');
      assert.equal(after.published, 3, 'the catalog (status = published) shows exactly the rows that were is_published');
    });

    await t.test('008 again changes nothing: no duplicate versions, no status reset', async () => {
      await client.query("UPDATE scenarios SET status = 'review' WHERE id = 'null-zip'");
      const before = await state();
      await client.query(m008);
      assert.deepEqual(await state(), before);
    });

    await t.test('009 drops is_published; running it again, or 008 after it, is harmless', async () => {
      await client.query(m009);
      const cols = (await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'scenarios'"
      )).rows.map(r => r.column_name);
      assert.ok(!cols.includes('is_published'));
      assert.ok(cols.includes('status'));

      const before = await state();
      await client.query(m009);
      await client.query(m008);
      assert.deepEqual(await state(), before);
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('187. the schema 008 leaves behind enforces its rules (DW-3.1)', async t => {
  if (skipUnlessDb(t)) return;
  const insert = (id, status = 'draft') => pool.query(
    "INSERT INTO scenarios (id, title, category, category_label, status) VALUES ($1, 'T', 'x', 'X', $2)", [id, status]);
  const version = (id, state, sha) => pool.query(
    'INSERT INTO scenario_versions (scenario_id, sha256, bytes, state) VALUES ($1, $2, 1, $3)', [id, SHA(sha), state]);

  await t.test('a new row defaults to draft; only the four statuses exist', async () => {
    await pool.query("INSERT INTO scenarios (id, title, category, category_label) VALUES ('m8-default', 'T', 'x', 'X')");
    assert.equal((await pool.query("SELECT status FROM scenarios WHERE id = 'm8-default'")).rows[0].status, 'draft');
    await assert.rejects(insert('m8-hidden', 'hidden'), /check constraint/);
    for (const status of ['review', 'published', 'rejected']) await insert(`m8-${status}`, status);
  });

  await t.test('a version state is one of current, pending, archived', async () => {
    await assert.rejects(version('m8-default', 'live', '1'), /check constraint/);
  });

  await t.test('at most one current and one pending version per scenario, any number archived', async () => {
    await version('m8-default', 'current', '1');
    await assert.rejects(version('m8-default', 'current', '2'), /unique/);
    await version('m8-default', 'pending', '3');
    await assert.rejects(version('m8-default', 'pending', '4'), /unique/);
    await version('m8-default', 'archived', '5');
    await version('m8-default', 'archived', '6');
  });

  await t.test('versions go with their scenario', async () => {
    await pool.query("DELETE FROM scenarios WHERE id = 'm8-default'");
    assert.equal((await pool.query("SELECT 1 FROM scenario_versions WHERE scenario_id = 'm8-default'")).rowCount, 0);
  });

  await t.test('the runner has recorded both migrations as applied', async () => {
    const { rows } = await pool.query(
      "SELECT name FROM schema_migrations WHERE name IN ('008_status_and_versions.sql', '009_drop_is_published.sql') ORDER BY name");
    assert.equal(rows.length, 2);
  });
});
