// backend/routes/version-tools.js
//
// What the moderator reads about one archive version and what is recorded against it.
//
//   GET  /api/scenarios/:id/versions/:vid/contents   owner or moderator -> {path, bytes, dir}[]
//   POST /api/scenarios/:id/versions/:vid/checks     owner or moderator: re-run -> {ok, items}
//   POST /api/scenarios/:id/versions/:vid/test-run   moderator: store a test-run report
//
// The first two read the stored object (`/srv/archives/objects/<sha>.zip`) under the same caps
// as an upload (`MAX_ARCHIVE_ENTRIES`, `MAX_ENTRY_BYTES`). A version id of another scenario is a
// 404, as on the other version routes.

const express = require('express');

const { pool, inTransaction } = require('../db');
const { authorize, requireScenarioEditor } = require('../auth');
const audit = require('../audit');
const { listArchiveEntries } = require('../archive-validation');
const { runArchiveChecks } = require('../archive-checks');
const { validateTestRun } = require('../test-run-input');
const storage = require('../storage');
const versions = require('../versions');
const { httpError, sendError } = require('../http-error');

const router = express.Router();

const base = '/api/scenarios/:id/versions/:vid';

router.get(`${base}/contents`, authorize('author'), requireScenarioEditor, async (req, res) => {
  try {
    const version = await versions.getVersionByParam(pool, req.params.id, req.params.vid);
    res.json(await listArchiveEntries(storage.objectPath(version.sha256)));
  } catch (err) {
    sendError(res, err, 'GET /api/scenarios/:id/versions/:vid/contents');
  }
});

router.post(`${base}/checks`, authorize('author'), requireScenarioEditor, async (req, res) => {
  try {
    const version = await versions.getVersionByParam(pool, req.params.id, req.params.vid);
    // Validated outside the transaction: it reads a file, and holds no lock while it does.
    const checks = await runArchiveChecks(storage.objectPath(version.sha256), req.params.id, version.bytes);

    await inTransaction(async db => {
      const { rowCount } = await db.query(
        'UPDATE scenario_versions SET checks = $1::jsonb WHERE id = $2 AND scenario_id = $3',
        [JSON.stringify(checks), version.id, req.params.id]
      );
      if (!rowCount) throw httpError(404, 'Версію не знайдено');
      await audit.record(db, req.principal, 'version.checks', req.params.id, {
        versionId: version.id, sha256: version.sha256, ok: checks.ok,
        errors: checks.items.filter(item => item.level === 'error').length,
      });
    });
    res.json(checks);
  } catch (err) {
    sendError(res, err, 'POST /api/scenarios/:id/versions/:vid/checks');
  }
});

router.post(`${base}/test-run`, authorize('moderator'), async (req, res) => {
  const checked = validateTestRun(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });

  try {
    const testRun = { ...checked.value, ranAt: new Date().toISOString(), ranBy: req.principal.label };
    await inTransaction(async db => {
      const version = await versions.getVersionByParam(db, req.params.id, req.params.vid);
      await db.query('UPDATE scenario_versions SET test_run = $1::jsonb WHERE id = $2', [JSON.stringify(testRun), version.id]);
      await audit.record(db, req.principal, 'version.test-run', req.params.id, {
        versionId: version.id, sha256: version.sha256, failed: testRun.error !== undefined,
      });
    });
    res.json({ testRun });
  } catch (err) {
    sendError(res, err, 'POST /api/scenarios/:id/versions/:vid/test-run');
  }
});

module.exports = { router };
