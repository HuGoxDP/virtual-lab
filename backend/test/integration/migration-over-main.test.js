// backend/test/integration/migration-over-main.test.js
//
// The merge of release 2 into `main`'s LTI work renumbered release 2's migrations to follow `main`'s
// 007_lti / 008_scenario_graded, which may already be applied in a deployed database. This proves
// the upgrade path on a throwaway database (so the shared test schema is untouched): a DB left by
// `main` (001-008, rows, LTI data) takes 009-013 cleanly, keeps its data, derives status and versions
// from `is_published`, copies `graded` onto the current version, and a second run changes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const { pool: sharedPool } = require('../../db');
const { runMigrations } = require('../../migrations');
const { isAvailable, createBaseline } = require('../helpers/db');

const MIGRATIONS = path.join(__dirname, '../../migrations');
const DB = `vl_over_main_${crypto.randomBytes(4).toString('hex')}`;
const SHA = ch => ch.repeat(64);

let available = false;
let pool;

test.before(async () => {
  available = await isAvailable(sharedPool);
  if (!available) return;
  await sharedPool.query(`CREATE DATABASE ${DB}`);
  pool = new Pool({
    host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432, database: DB,
    user: process.env.DB_USER || 'lab_user', password: process.env.DB_PASSWORD,
  });
});

test.after(async () => {
  if (pool) await pool.end();
  if (available) await sharedPool.query(`DROP DATABASE IF EXISTS ${DB}`);
  await sharedPool.end();
});

/** Leaves the database as `main` deployed it: the baseline plus 001-008 applied and recorded. */
async function buildMainDatabase() {
  await createBaseline(pool);
  await pool.query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const files = (await fsp.readdir(MIGRATIONS)).filter(f => f.endsWith('.sql') && f < '009').sort();
  assert.deepEqual(files.slice(-2), ['007_lti.sql', '008_scenario_graded.sql']);
  for (const file of files) {
    await pool.query(await fsp.readFile(path.join(MIGRATIONS, file), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}

const statusOf = async () => Object.fromEntries((await pool.query('SELECT id, status FROM scenarios')).rows.map(r => [r.id, r.status]));
const applied = async () => (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name);

test('009-013 apply on top of main\'s 001-008, keep its data, and a second run is a no-op', async t => {
  if (!available) return t.skip('no database reachable');
  await buildMainDatabase();

  // What a deployed `main` holds: published and unpublished rows, a graded scenario with an archive, a
  // streamed-only row (no archive), and LTI data.
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, scenario_url, is_published, graded, archive_sha256, archive_bytes) VALUES
      ('live-graded',  'A', 'physics',   'Фізика',    '/scenarios/${SHA('a')}.zip', true,  true,  '${SHA('a')}', 100),
      ('live-plain',   'B', 'biology',   'Біологія',  '/scenarios/${SHA('b')}.zip', true,  false, '${SHA('b')}', 200),
      ('hidden',       'C', 'astronomy', 'Астрономія','/scenarios/${SHA('c')}.zip', false, true,  '${SHA('c')}', 300)`);
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, is_published, manifest_url)
    VALUES ('streamed-only', 'D', 'physics', 'Фізика', true, '/a/streamed-only.json')`);
  await pool.query(`
    INSERT INTO lti_registrations (issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_uri)
    VALUES ('https://lms.example', 'c1', '{d1}', 'https://lms.example/a', 'https://lms.example/t', 'https://lms.example/j')`);

  await runMigrations(pool);

  assert.deepEqual((await applied()).slice(-5), [
    '009_keys_roles_audit.sql', '010_status_and_versions.sql', '011_drop_is_published.sql',
    '012_previews_and_manifest_id.sql', '013_scenario_versions_graded.sql',
  ]);
  assert.deepEqual(await statusOf(), { 'live-graded': 'published', 'live-plain': 'published', hidden: 'draft', 'streamed-only': 'published' });

  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'scenarios'")).rows.map(r => r.column_name);
  assert.ok(!columns.includes('is_published'), 'is_published is gone');
  assert.ok(columns.includes('graded') && columns.includes('status'));

  // One current version per archived row; the graded flag follows the row it was copied from.
  const versions = (await pool.query('SELECT scenario_id, state, graded FROM scenario_versions ORDER BY scenario_id')).rows;
  assert.deepEqual(versions, [
    { scenario_id: 'hidden', state: 'current', graded: true },
    { scenario_id: 'live-graded', state: 'current', graded: true },
    { scenario_id: 'live-plain', state: 'current', graded: false },
  ]);
  assert.equal((await pool.query("SELECT 1 FROM scenarios WHERE id = 'live-graded' AND graded")).rowCount, 1, 'scenarios.graded kept');
  assert.equal((await pool.query('SELECT 1 FROM lti_registrations')).rowCount, 1, 'LTI data kept');

  // Applying again: nothing to do, and the raw SQL of every renumbered file re-runs cleanly too.
  const before = await statusOf();
  await runMigrations(pool);
  for (const file of (await fsp.readdir(MIGRATIONS)).filter(f => f >= '009' && f.endsWith('.sql')).sort()) {
    await pool.query(await fsp.readFile(path.join(MIGRATIONS, file), 'utf8'));
  }
  assert.deepEqual(await statusOf(), before);
  assert.equal((await pool.query('SELECT 1 FROM scenario_versions')).rowCount, 3, 'no duplicate versions');
  assert.equal((await pool.query("SELECT 1 FROM scenario_versions WHERE graded")).rowCount, 2);
});

test('013 backfills only the current version, from scenarios.graded, and twice changes nothing', async t => {
  if (!available) return t.skip('no database reachable');
  // Continues on the database the previous test migrated.
  const client = await pool.connect();
  const sql = await fsp.readFile(path.join(MIGRATIONS, '013_scenario_versions_graded.sql'), 'utf8');
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE scenario_versions DROP COLUMN graded');
    await client.query(`
      INSERT INTO scenario_versions (scenario_id, sha256, bytes, state) VALUES ('live-graded', '${SHA('e')}', 1, 'archived')`);
    await client.query(sql);
    const read = async () => (await client.query(
      'SELECT scenario_id, state, graded FROM scenario_versions ORDER BY scenario_id, state')).rows;
    const once = await read();
    assert.deepEqual(once.filter(v => v.scenario_id === 'live-graded'), [
      { scenario_id: 'live-graded', state: 'archived', graded: false },
      { scenario_id: 'live-graded', state: 'current', graded: true },
    ]);
    await client.query(sql);
    assert.deepEqual(await read(), once);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
