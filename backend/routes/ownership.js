// backend/routes/ownership.js
//
// B6 phase 3: who a scenario belongs to. A moderator hands a scenario from one
// key to another — the one thing rotation cannot do (rotation replaces a key,
// and the rows move with it). The history never moves: `scenario_versions.
// uploaded_by_key_id` records who uploaded each version and is not rewritten
// here, so the journal keeps its answer even when the owner changed.

const express = require('express');

const { pool, inTransaction } = require('../db');
const { authorize } = require('../auth');
const audit = require('../audit');
const { httpError } = require('../http-error');

const router = express.Router();

/** Postgres INTEGER ceiling; a larger id cannot exist and would raise a type error. */
const MAX_KEY_ID = 2_147_483_647;

/**
 * Parse a `keyId` from the body: a number within the INTEGER range, or the
 * literal null (which hands the scenario to nobody — moderators only).
 */
function parseTargetKeyId(body) {
  const raw = body?.keyId;
  if (raw === null) return { value: null };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > MAX_KEY_ID) {
    return { error: 'keyId має бути цілим числом від 1 до 2147483647, або null' };
  }
  return { value: raw };
}

// ── PUT /api/scenarios/:id/owner ─────────────────────
// Moderator only: an author cannot give their own work away, and cannot take
// it. The answer is the scenario's new owner, as the catalog row sees it.
router.put('/api/scenarios/:id/owner', authorize('moderator'), async (req, res) => {
  const parsed = parseTargetKeyId(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    const moved = await inTransaction(async db => {
      const { rows } = await db.query(
        'SELECT owner_key_id FROM scenarios WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );
      if (!rows[0]) throw httpError(404, 'Сценарій не знайдено');

      // A revoked or unknown target is a refusal, not a silent null: the caller
      // asked for one specific key and gets the answer to that question.
      if (parsed.value !== null) {
        const target = await db.query(
          'SELECT id, revoked_at FROM publish_keys WHERE id = $1',
          [parsed.value]
        );
        if (!target.rows[0] || target.rows[0].revoked_at) {
          throw httpError(400, 'Ключ не знайдено або відкликаний');
        }
      }

      const from = rows[0].owner_key_id;
      if (from === parsed.value) {
        throw httpError(409, 'Сценарій уже належить цьому ключу');
      }

      const updated = await db.query(
        'UPDATE scenarios SET owner_key_id = $1 WHERE id = $2 RETURNING owner_key_id',
        [parsed.value, req.params.id]
      );
      await audit.record(db, req.principal, 'scenario.owner', req.params.id, {
        from,
        to: parsed.value,
      });
      return updated.rows[0].owner_key_id;
    });

    res.json({ id: req.params.id, ownerKeyId: moved });
  } catch (err) {
    if (err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[OWNERSHIP] transfer error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

module.exports = { router };
