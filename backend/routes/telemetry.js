// backend/routes/telemetry.js
//
// Anonymous scenario sessions, and the admin summary of them.

const express = require('express');
const rateLimit = require('express-rate-limit');

const { pool, scenarioExists } = require('../db');
const { authorize } = require('../auth');

const router = express.Router();

/** Anything longer is a tab left open overnight, not a session. */
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const telemetryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.TELEMETRY_RATE_LIMIT || 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Забагато запитів' },
});

/**
 * POST /api/telemetry/session   { scenarioId, clientId? }
 *
 * Records that a scenario started. Public and anonymous — `clientId` is a
 * random per-browser UUID, never tied to a person.
 */
router.post('/api/telemetry/session', telemetryLimiter, async (req, res) => {
  const scenarioId = typeof req.body?.scenarioId === 'string' ? req.body.scenarioId : '';
  const rawClientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
  const clientId = UUID_PATTERN.test(rawClientId) ? rawClientId : null;

  if (!scenarioId) {
    return res.status(400).json({ error: 'scenarioId обов\'язковий' });
  }

  try {
    // Bound the data to real scenarios so the table cannot be filled with junk.
    if (!(await scenarioExists(scenarioId))) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    const userAgent = (req.get('user-agent') || '').slice(0, 300);

    const { rows } = await pool.query(`
      INSERT INTO scenario_sessions (scenario_id, client_id, user_agent)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [scenarioId, clientId, userAgent]);

    res.status(201).json({ sessionId: String(rows[0].id) });
  } catch (err) {
    console.error('[TELEMETRY] start error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

/**
 * POST /api/telemetry/session/:id/end
 *
 * Closes a session. POST rather than PATCH so the browser can send it with
 * `navigator.sendBeacon` during unload, which is the only reliable moment.
 *
 * Idempotent by construction: the UPDATE only matches a session that is still
 * open, so a replay cannot inflate anything. Duration is computed server-side
 * from `started_at` and clamped — it is never taken from the client.
 */
router.post('/api/telemetry/session/:id/end', telemetryLimiter, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Невалідний id сесії' });
  }

  try {
    await pool.query(`
      UPDATE scenario_sessions
         SET ended_at    = NOW(),
             duration_ms = LEAST(
               GREATEST(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000, 0),
               $2
             )::int
       WHERE id = $1
         AND ended_at IS NULL
    `, [id, MAX_SESSION_MS]);

    // 204 regardless: sendBeacon ignores the response, and telling a caller
    // whether a session id exists would leak nothing useful anyway.
    res.status(204).end();
  } catch (err) {
    console.error('[TELEMETRY] end error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

/**
 * GET /api/telemetry/summary?days=30   (moderator)
 *
 * Launches and median duration per scenario. Median rather than mean: one tab
 * left open for hours would otherwise dominate the average.
 */
router.get('/api/telemetry/summary', authorize('moderator'), async (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), 365);

  try {
    const { rows } = await pool.query(`
      SELECT
        s.scenario_id                                   AS "scenarioId",
        c.title                                         AS "title",
        COUNT(*)::int                                   AS "launches",
        COUNT(s.ended_at)::int                          AS "completed",
        COUNT(DISTINCT s.client_id)::int                AS "uniqueClients",
        COALESCE(
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.duration_ms), 0
        )::int                                          AS "medianDurationMs",
        MAX(s.started_at)                               AS "lastStartedAt"
      FROM scenario_sessions s
      LEFT JOIN scenarios c ON c.id = s.scenario_id
      WHERE s.started_at >= NOW() - ($1 || ' days')::interval
      GROUP BY s.scenario_id, c.title
      ORDER BY "launches" DESC
    `, [String(days)]);

    res.json({ days, scenarios: rows });
  } catch (err) {
    console.error('[TELEMETRY] summary error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

module.exports = { router };
