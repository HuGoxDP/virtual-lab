// backend/migrations.js

const fs = require('node:fs/promises');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Arbitrary but fixed key so concurrent backends cannot migrate at the same time. */
const ADVISORY_LOCK_KEY = 4823_1917;

/**
 * Applies every unapplied file in `backend/migrations/` in filename order,
 * each in its own transaction.
 *
 * `db/init.sql` runs only when Postgres creates its data directory, so it
 * cannot carry schema changes for an existing deployment — this can.
 */
async function runMigrations(pool) {
  let files;
  try {
    files = (await fs.readdir(MIGRATIONS_DIR))
      .filter(name => name.endsWith('.sql'))
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('[MIGRATE] No migrations directory, nothing to do');
      return;
    }
    throw err;
  }

  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map(row => row.name));

    let count = 0;

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }

      console.log(`[MIGRATE] applied ${file}`);
      count++;
    }

    console.log(count === 0
      ? '[MIGRATE] Schema up to date'
      : `[MIGRATE] Applied ${count} migration(s)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

module.exports = { runMigrations };
