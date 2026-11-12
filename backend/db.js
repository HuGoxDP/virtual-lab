// backend/db.js
//
// The one connection pool and the helpers every route module shares.

const { Pool } = require('pg');
const { ITEM_FROM, PUBLIC_ROW } = require('./scenario-rows');

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

/**
 * Whether a scenario id exists **and is public** — the same condition every
 * public read uses (`scenario-rows.js`'s `PUBLIC_ROW`), because an id check
 * here is a public answer: 201 for an existing but hidden slug would let an
 * anonymous caller enumerate the unpublished catalog (F-R4, B6r2). A bogus id
 * still answers the same 404 as before.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function scenarioExists(id) {
  const { rowCount } = await pool.query(`
    SELECT 1
      ${ITEM_FROM}
     WHERE s.id = $1 AND ${PUBLIC_ROW}
  `, [id]);
  return rowCount > 0;
}

module.exports = { pool, inTransaction, scenarioExists };
