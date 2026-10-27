// backend/routes/bulk.js
//
// POST /api/scenarios/bulk   (moderator)   { ids, action, category? }
//   action: approve | unpublish | set-category | delete
//   -> 200 { results: [{ id, ok, error? }] }
//
// Each id is its own transaction, so one scenario that cannot move (no archive, wrong status,
// unknown id) never blocks or undoes the others; the answer says which did what. A request that
// is malformed as a whole (no ids, too many, unknown action, a category that does not exist)
// is a 400 before anything runs. Every success writes the same audit row the single-scenario
// route would, flagged `bulk`.

const express = require('express');

const { inTransaction } = require('../db');
const { authorize } = require('../auth');
const audit = require('../audit');
const { MAX_BULK_IDS } = require('../config');
const { applyTransition } = require('../workflow');
const { httpError, describeError } = require('../http-error');

const router = express.Router();

const transition = action => (db, principal, id) => applyTransition(db, principal, id, action);

/** One action on one scenario, inside the caller's transaction; throws `httpError` to refuse. */
const ACTIONS = {
  approve: transition('approve'),
  unpublish: transition('unpublish'),

  async 'set-category'(db, principal, id, { category }) {
    const { rows: [target] } = await db.query('SELECT label FROM categories WHERE slug = $1 FOR SHARE', [category]);
    if (!target) throw httpError(400, 'Невідома категорія');
    const { rowCount } = await db.query(
      'UPDATE scenarios SET category = $2, category_label = $3, updated_at = NOW() WHERE id = $1',
      [id, category, target.label]
    );
    if (!rowCount) throw httpError(404, 'Сценарій не знайдено');
    await audit.record(db, principal, 'scenario.update', id, { fields: ['category'], category, bulk: true });
  },

  async delete(db, principal, id) {
    const { rowCount } = await db.query('DELETE FROM scenarios WHERE id = $1', [id]);
    if (!rowCount) throw httpError(404, 'Сценарій не знайдено');
    await audit.record(db, principal, 'scenario.delete', id, { bulk: true });
  },
};

router.post('/api/scenarios/bulk', authorize('moderator'), async (req, res) => {
  const { ids, action, category } = req.body ?? {};

  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !id)) {
    return res.status(400).json({ error: 'ids має бути непорожнім масивом рядків' });
  }
  if (ids.length > MAX_BULK_IDS) {
    return res.status(400).json({ error: `ids: не більше ${MAX_BULK_IDS} за один запит` });
  }
  if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) {
    return res.status(400).json({ error: `action: одне з ${Object.keys(ACTIONS).join(', ')}` });
  }
  if (action === 'set-category' && (typeof category !== 'string' || !category)) {
    return res.status(400).json({ error: 'Для set-category потрібне поле category' });
  }

  const results = [];
  for (const id of new Set(ids)) {
    try {
      await inTransaction(db => ACTIONS[action](db, req.principal, id, { category }));
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: describeError(err, `POST /api/scenarios/bulk ${action}`).message });
    }
  }
  res.json({ results });
});

module.exports = { router };
