// backend/routes/archives.js
//
// Archive upload — content-addressed storage.

const express = require('express');
const multer = require('multer');

const { pool, inTransaction } = require('../db');
const { authorize, canEditScenario } = require('../auth');
const { limitAuthorUploads } = require('../rate-limits');
const audit = require('../audit');
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
 * POST /api/scenarios/:id/archive   (author who owns it while unpublished, or moderator;
 * multipart field "archive")
 *
 * Stores the upload as /scenarios/<sha256>.zip and repoints the scenario at it.
 * Identical content uploaded twice reuses the same object. Author uploads are
 * rate-limited per key (`limitAuthorUploads`) before the body is read.
 */
router.post('/api/scenarios/:id/archive', authorize('author'), limitAuthorUploads, receiveArchive, async (req, res) => {
  const { id } = req.params;
  const { principal } = req;
  const tmpFile = req.file?.path;

  // commitArchive either renames the temp file into the store or deletes it;
  // every other exit path — including the early 404 — must clean up itself.
  let consumed = false;

  /** Does the work and returns the response; throws only for a failure. */
  async function ingest() {
    if (!tmpFile) {
      return { status: 400, body: { error: 'Очікується файл у полі "archive"' } };
    }
    console.log(`[ARCHIVE] ${id}: прийнято файл ${req.file.originalname} (${req.file.size} bytes)`);

    const { rows } = await pool.query('SELECT owner_key_id, is_published FROM scenarios WHERE id = $1', [id]);
    if (!rows[0]) return { status: 404, body: { error: 'Сценарій не знайдено' } };
    if (!canEditScenario(principal, rows[0])) {
      return { status: 403, body: { error: 'Це не ваш сценарій' } };
    }
    // An author's published scenario changes only through a moderated path (a later phase).
    if (principal.role === 'author' && rows[0].is_published) {
      return { status: 403, body: { error: 'Опублікований сценарій не можна змінити завантаженням' } };
    }

    // Validate before committing — a broken archive must never enter the store.
    const { manifest, warnings } = await validateScenarioArchive(tmpFile, id);
    console.log(`[ARCHIVE] ${id}: маніфест прочитано (id="${manifest.id}", version=${manifest.version})`);
    for (const warning of warnings) console.log(`[ARCHIVE] ${id}: попередження — ${warning}`);

    const result = await storage.commitArchive(tmpFile);
    consumed = true;
    console.log(`[ARCHIVE] ${id}: sha256=${result.sha256} ${result.deduplicated ? '(вже є в сховищі, дедуп)' : '(новий об\'єкт збережено)'}`);

    await inTransaction(async db => {
      await attachArchive(db, id, result, manifest);
      await audit.record(db, principal, 'scenario.archive', id, {
        sha256: result.sha256, bytes: result.bytes, deduplicated: result.deduplicated,
      });
    });
    console.log(`[ARCHIVE] ${id}: запис каталогу оновлено → ${result.url} (${result.bytes} bytes)`);

    return { status: 201, body: { id, ...result, manifestId: manifest.id, warnings } };
  }

  let outcome;
  try {
    outcome = await ingest();
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[ARCHIVE] Upload error:', err.message);
    outcome = { status, body: { error: err.message } };
  } finally {
    // Before the response, not after: a client that reacts to it may look at the temp dir.
    if (!consumed) await storage.discardTemp(tmpFile);
  }
  res.status(outcome.status).json(outcome.body);
});

module.exports = { router };
