// backend/routes/dashboard.js
//
// What the admin landing page and a scenario's history tab read. Both come from the journal
// (`audit_events`) and the scenario table, scoped to the principal: an author sees only the
// scenarios their key owns, a moderator everything.
//
//   GET /api/admin/dashboard           any principal -> { counts, queueSize, activity }
//   GET /api/scenarios/:id/history     owner or moderator -> AuditRow[]

const express = require('express');

const { pool } = require('../db');
const { authorize, requireScenarioEditor } = require('../auth');
const audit = require('../audit');
const { sendError } = require('../http-error');

const router = express.Router();

/** Statuses a scenario can have; the counts always list every one, zero included. */
const STATUSES = ['draft', 'review', 'published', 'rejected'];

const DASHBOARD_ACTIVITY = 20;
const HISTORY_LIMIT = 200;

router.get('/api/admin/dashboard', authorize('author'), async (req, res) => {
  const { principal } = req;
  const ownerKeyId = principal.role === 'author' ? principal.keyId : null;

  try {
    const [counted, queue, activity] = await Promise.all([
      pool.query(`
        SELECT status, COUNT(*)::int AS count FROM scenarios
         WHERE ($1::int IS NULL OR owner_key_id = $1) GROUP BY status
      `, [ownerKeyId]),
      // The moderation queue: scenarios submitted for review, and live ones with an
      // author's new archive waiting. A scenario that is both counts once.
      pool.query(`
        SELECT COUNT(*)::int AS count FROM scenarios s
         WHERE ($1::int IS NULL OR s.owner_key_id = $1)
           AND (s.status = 'review'
                OR EXISTS (SELECT 1 FROM scenario_versions v WHERE v.scenario_id = s.id AND v.state = 'pending'))
      `, [ownerKeyId]),
      audit.listActivity(pool, { ownerKeyId, limit: DASHBOARD_ACTIVITY }),
    ]);

    const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
    for (const row of counted.rows) counts[row.status] = row.count;

    res.json({ counts, queueSize: queue.rows[0].count, activity });
  } catch (err) {
    sendError(res, err, 'GET /api/admin/dashboard');
  }
});

router.get('/api/scenarios/:id/history', authorize('author'), requireScenarioEditor, async (req, res) => {
  try {
    res.json(await audit.listActivity(pool, { scenarioId: req.params.id, limit: HISTORY_LIMIT }));
  } catch (err) {
    sendError(res, err, 'GET /api/scenarios/:id/history');
  }
});

module.exports = { router };
