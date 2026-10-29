// backend/test/integration/migration-009.test.js
//
// Test-plan scenario 185 (DW-2.7): migration 009 applies twice without error
// and leaves the schema the keys, ownership and journal rely on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { pool } = require('../../server');
const { runMigrations } = require('../../migrations');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');

const MIGRATION = path.join(__dirname, '../../migrations/009_keys_roles_audit.sql');

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

const columnsOf = async table => (await pool.query(
  'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]
)).rows.map(r => r.column_name);

test('185. migration 009 applies twice without error (DW-2.7)', async t => {
  if (skipUnlessDb(t)) return;
  const sql = await fsp.readFile(MIGRATION, 'utf8');

  await t.test('the raw SQL re-runs cleanly on a migrated database', async () => {
    await pool.query(sql);
    await pool.query(sql);
  });

  await t.test('and keeps existing data', async () => {
    await pool.query("INSERT INTO publish_keys (label, role, token_hash) VALUES ('keep', 'author', repeat('a', 64))");
    await pool.query(sql);
    assert.equal((await pool.query("SELECT 1 FROM publish_keys WHERE label = 'keep'")).rowCount, 1);
  });

  await t.test('the runner has recorded it as applied and has nothing left to do', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE name = '009_keys_roles_audit.sql'");
    assert.equal(rows.length, 1);
  });

  await t.test('on a database from before 009 it creates everything from scratch', async () => {
    await pool.query('DROP TABLE IF EXISTS audit_events');
    await pool.query('ALTER TABLE scenarios DROP COLUMN IF EXISTS owner_key_id');
    await pool.query('DROP TABLE IF EXISTS publish_keys CASCADE');
    await pool.query(sql);
    assert.deepEqual((await columnsOf('publish_keys')).sort(),
      ['created_at', 'id', 'label', 'last_used_at', 'revoked_at', 'role', 'token_hash']);
    assert.ok((await columnsOf('scenarios')).includes('owner_key_id'));
    assert.deepEqual((await columnsOf('audit_events')).sort(),
      ['action', 'actor_key_id', 'actor_label', 'created_at', 'details', 'id', 'scenario_id']);
  });
});

test('185. constraints the keys rely on', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('only author and moderator are roles', async () => {
    await assert.rejects(
      pool.query("INSERT INTO publish_keys (label, role, token_hash) VALUES ('x', 'admin', repeat('b', 64))"),
      /check constraint/
    );
  });

  await t.test('a token hash is unique', async () => {
    await pool.query("INSERT INTO publish_keys (label, role, token_hash) VALUES ('one', 'author', repeat('c', 64))");
    await assert.rejects(
      pool.query("INSERT INTO publish_keys (label, role, token_hash) VALUES ('two', 'author', repeat('c', 64))"),
      /unique/
    );
  });

  await t.test('a scenario owner must be a real key, and existing rows need none', async () => {
    await assert.rejects(pool.query(`
      INSERT INTO scenarios (id, title, category, category_label, owner_key_id)
      VALUES ('m7-bad', 'T', 'x', 'X', 987654)`), /foreign key/);
    await pool.query("INSERT INTO scenarios (id, title, category, category_label) VALUES ('m7-ok', 'T', 'x', 'X')");
    assert.equal((await pool.query("SELECT owner_key_id FROM scenarios WHERE id = 'm7-ok'")).rows[0].owner_key_id, null);
  });

  await t.test('audit_events has no foreign key on scenario_id: history survives deletion', async () => {
    const { rows } = await pool.query(`
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'audit_events'::regclass AND contype = 'f'`);
    assert.equal(rows.length, 0);
    await pool.query("INSERT INTO audit_events (scenario_id, actor_label, action) VALUES ('no-such-scenario', 'x', 'y')");
  });
});
