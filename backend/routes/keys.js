// backend/routes/keys.js
//
// Personal publish keys (moderator-only) and `GET /api/auth/me`.
//
// A token is generated here, returned once in the POST response and never
// stored: only its SHA-256 is. It is not logged and not listed.

const crypto = require('node:crypto');
const express = require('express');

const { pool, inTransaction } = require('../db');
const { authenticate, authorize, sha256Hex } = require('../auth');
const audit = require('../audit');

const router = express.Router();

const ROLES = ['author', 'moderator'];
const MAX_LABEL_LENGTH = 100;
/** Postgres INTEGER ceiling; a larger id cannot exist and would raise a type error. */
const MAX_KEY_ID = 2_147_483_647;

const KEY_COLUMNS = `
  id, label, role,
  created_at   AS "createdAt",
  last_used_at AS "lastUsedAt",
  revoked_at   AS "revokedAt"
`;

// ── GET /api/auth/me ─────────────────────────────────
// Any valid principal; a revoked or unknown key never gets this far (403).
router.get('/api/auth/me', authenticate, (req, res) => {
  const { role, label, keyId } = req.principal;
  res.json({ role, label, keyId });
});

// ── GET /api/keys ────────────────────────────────────
router.get('/api/keys', authorize('moderator'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${KEY_COLUMNS} FROM publish_keys ORDER BY id`);
    res.json({ keys: rows });
  } catch (err) {
    console.error('[KEYS] list error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── POST /api/keys ───────────────────────────────────
router.post('/api/keys', authorize('moderator'), async (req, res) => {
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const { role } = req.body ?? {};

  if (!label || label.length > MAX_LABEL_LENGTH) {
    return res.status(400).json({ error: `label: від 1 до ${MAX_LABEL_LENGTH} символів` });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role має бути одним із: ${ROLES.join(', ')}` });
  }

  const token = crypto.randomBytes(32).toString('base64url');

  try {
    const key = await inTransaction(async db => {
      const { rows } = await db.query(
        'INSERT INTO publish_keys (label, role, token_hash) VALUES ($1, $2, $3) RETURNING id',
        [label, role, sha256Hex(token)]
      );
      await audit.record(db, req.principal, 'key.create', null, { keyId: rows[0].id, label, role });
      return rows[0];
    });

    // The only moment the token exists in clear; it must not be cached.
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ id: key.id, label, role, token });
  } catch (err) {
    console.error('[KEYS] create error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── POST /api/keys/:id/revoke ────────────────────────
// Idempotent: revoking a revoked key keeps its first revocation time.
router.post('/api/keys/:id/revoke', authorize('moderator'), async (req, res) => {
  const id = /^\d{1,10}$/.test(req.params.id) ? Number(req.params.id) : NaN;
  if (!Number.isSafeInteger(id) || id > MAX_KEY_ID) {
    return res.status(400).json({ error: 'Невалідний id ключа' });
  }

  try {
    const key = await inTransaction(async db => {
      const { rows } = await db.query(`
        UPDATE publish_keys SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE id = $1
        RETURNING ${KEY_COLUMNS}
      `, [id]);
      if (rows[0]) await audit.record(db, req.principal, 'key.revoke', null, { keyId: id });
      return rows[0];
    });

    if (!key) return res.status(404).json({ error: 'Ключ не знайдено' });
    res.json(key);
  } catch (err) {
    console.error('[KEYS] revoke error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

module.exports = { router };
