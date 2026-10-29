// backend/db.js
//
// The one connection pool and the helpers every route module shares.

const { Pool } = require('pg');

// ── Подключение к PostgreSQL ─────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'virtual_lab',
  user:     process.env.DB_USER     || 'lab_user',
  password: process.env.DB_PASSWORD,
});

// An idle client can emit 'error' (database restart, dropped connection).
// Without a listener that is an unhandled error event and takes the process
// down; pg discards the broken client on its own.
pool.on('error', err => {
  console.error('[DB] Idle client error:', err.message);
});

/** Runs `work(client)` in a transaction; rolls back and rethrows on any failure. */
async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function scenarioExists(id) {
  const { rowCount } = await pool.query('SELECT 1 FROM scenarios WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { pool, inTransaction, scenarioExists };
