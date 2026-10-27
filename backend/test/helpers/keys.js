// backend/test/helpers/keys.js
//
// Personal keys for tests, inserted straight into `publish_keys` so a test of
// something else does not depend on the keys API. The hash is computed here,
// independently of `auth.js`, so a drift in either shows up as a failing login.

const crypto = require('node:crypto');

const sha256Hex = text => crypto.createHash('sha256').update(text).digest('hex');

/** Inserts a key and returns `{ id, token, label, role, auth }` (`auth` is the header object). */
async function createKey(pool, role, label) {
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows } = await pool.query(
    'INSERT INTO publish_keys (label, role, token_hash) VALUES ($1, $2, $3) RETURNING id',
    [label, role, sha256Hex(token)]
  );
  return { id: rows[0].id, token, label, role, auth: { Authorization: `Bearer ${token}` } };
}

async function revokeKey(pool, id) {
  await pool.query('UPDATE publish_keys SET revoked_at = NOW() WHERE id = $1', [id]);
}

module.exports = { createKey, revokeKey, sha256Hex };
