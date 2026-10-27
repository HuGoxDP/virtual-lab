// backend/routes/health.js

const express = require('express');

const { pool } = require('../db');

const router = express.Router();

/**
 * Identity of *this* build — the API's, not the engine's.
 *
 * The split is deliberate. The engine build is a property of the bundle running
 * in the browser, and the browser is the only place that can read it
 * (`BuildInfo`, shown in the viewer under `?diag=1`). Reporting it from here
 * would mean the backend restating something it cannot observe, and the two
 * would drift the moment a new tarball was installed without a backend rebuild.
 *
 * `commit` is null unless the image was built with API_COMMIT set. Null is the
 * honest answer for "built from a working tree" — better than a stale default.
 */
const API_BUILD = {
  version: require('../package.json').version,
  commit: process.env.API_COMMIT || null,
  startedAt: new Date().toISOString(),
};

router.get('/api/health', async (req, res) => {
  const build = { ...API_BUILD, uptimeSeconds: Math.round(process.uptime()) };

  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', build });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected', build });
  }
});

module.exports = { router };
