// backend/routes/archives.js
//
// Archive upload — content-addressed storage.

const express = require('express');
const multer = require('multer');

const { inTransaction, scenarioExists } = require('../db');
const { requireAdmin } = require('../auth');
const { MAX_ARCHIVE_BYTES } = require('../config');
const storage = require('../storage');
const { validateScenarioArchive } = require('../archive-validation');

const router = express.Router();

const upload = multer({
  dest: storage.TMP_DIR,
  // busboy raises its limit event on reaching fileSize, not on exceeding it, so +1
  // makes an archive of exactly MAX_ARCHIVE_BYTES acceptable.
  limits: { fileSize: MAX_ARCHIVE_BYTES + 1, files: 1 },
});

/**
 * Runs multer and maps its errors to responses. Without this they escape the
 * route's own try/catch and surface as a 500; multer has already removed the
 * partial temp file by the time it reports one.
 */
function receiveArchive(req, res, next) {
  upload.single('archive')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mib = Math.round(MAX_ARCHIVE_BYTES / (1024 * 1024));
      return res.status(413).json({ error: `Архів завеликий: максимум ${mib} МіБ` });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: 'Некоректне завантаження файлу' });
    }
    next(err);
  });
}

/** Points a scenario at a stored object and records its integrity metadata. */
async function attachArchive(db, id, { sha256, bytes, url }, manifest) {
  await db.query(`
    UPDATE scenarios
       SET scenario_url            = $1,
           archive_sha256          = $2,
           archive_bytes           = $3,
           manifest_id             = $4,
           manifest_version        = $5,
           manifest_engine_version = $6,
           storage_kind            = 'local',
           updated_at              = NOW()
     WHERE id = $7
  `, [
    url, sha256, bytes,
    manifest?.id ?? null,
    manifest?.version ?? null,
    // Which engine build the scenario was compiled against — null for archives
    // predating ScenarioCreator stamping it.
    manifest?.engineVersion ?? null,
    id,
  ]);
}

/**
 * POST /api/scenarios/:id/archive   (admin, multipart field "archive")
 *
 * Stores the upload as /scenarios/<sha256>.zip and repoints the scenario at it.
 * Identical content uploaded twice reuses the same object.
 */
router.post('/api/scenarios/:id/archive', requireAdmin, receiveArchive, async (req, res) => {
  const { id } = req.params;
  const tmpFile = req.file?.path;

  // commitArchive either renames the temp file into the store or deletes it;
  // every other exit path — including the early 404 — must clean up itself.
  let consumed = false;

  try {
    if (!tmpFile) {
      return res.status(400).json({ error: 'Очікується файл у полі "archive"' });
    }
    console.log(`[ARCHIVE] ${id}: прийнято файл ${req.file.originalname} (${req.file.size} bytes)`);

    if (!(await scenarioExists(id))) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    // Validate before committing — a broken archive must never enter the store.
    const { manifest, warnings } = await validateScenarioArchive(tmpFile, id);
    console.log(`[ARCHIVE] ${id}: маніфест прочитано (id="${manifest.id}", version=${manifest.version})`);
    for (const warning of warnings) console.log(`[ARCHIVE] ${id}: попередження — ${warning}`);

    const result = await storage.commitArchive(tmpFile);
    consumed = true;
    console.log(`[ARCHIVE] ${id}: sha256=${result.sha256} ${result.deduplicated ? '(вже є в сховищі, дедуп)' : '(новий об\'єкт збережено)'}`);

    await inTransaction(db => attachArchive(db, id, result, manifest));
    console.log(`[ARCHIVE] ${id}: запис каталогу оновлено → ${result.url} (${result.bytes} bytes)`);

    res.status(201).json({ id, ...result, manifestId: manifest.id, warnings });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[ARCHIVE] Upload error:', err.message);
    res.status(status).json({ error: err.message });
  } finally {
    if (!consumed) await storage.discardTemp(tmpFile);
  }
});

module.exports = { router };
