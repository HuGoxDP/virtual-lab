// backend/routes/previews.js
//
// A scenario's cover image. This is the only way an author sets `imageUrl` (a PUT/POST may
// only clear it, restate it or point at a stored preview: `imageUrlProblem`).
//
//   POST   /api/scenarios/:id/preview   owner or moderator; multipart field "preview"
//                                       -> { imageUrl, warnings }
//   DELETE /api/scenarios/:id/preview   owner or moderator; clears the cover
//
// The image is inspected from its bytes (`preview-image.js`), stored under its content hash
// (`/previews/<sha256>.png|jpg`, served by nginx) and the row is pointed at it in one
// transaction. A replaced or removed image is left to GC, like a deleted archive version.

const express = require('express');
const multer = require('multer');

const { inTransaction } = require('../db');
const { authorize, canEditScenario, requireScenarioEditor } = require('../auth');
const audit = require('../audit');
const { PREVIEW_MAX_BYTES } = require('../config');
const { inspectPreview } = require('../preview-image');
const storage = require('../storage');
const { httpError, sendError } = require('../http-error');

const router = express.Router();

// Held in memory: at most PREVIEW_MAX_BYTES + 1 per request, and the bytes are inspected before
// anything touches the disk. +1 because busboy fires its limit on *reaching* fileSize, so a
// file of exactly the maximum must stay acceptable.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PREVIEW_MAX_BYTES + 1, files: 1 },
});

/** Runs multer and answers its errors as 400s (an oversize image is a bad file, not a 413). */
function receivePreview(req, res, next) {
  upload.single('preview')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `Зображення завелике: максимум ${PREVIEW_MAX_BYTES / (1024 * 1024)} МіБ` });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: 'Некоректне завантаження файлу' });
    }
    next(err);
  });
}

/** Locks the scenario row, checks the principal may edit it, returns the current `image_url`. */
async function lockEditable(db, id, principal) {
  const { rows: [row] } = await db.query('SELECT owner_key_id, image_url FROM scenarios WHERE id = $1 FOR UPDATE', [id]);
  if (!row) throw httpError(404, 'Сценарій не знайдено');
  if (!canEditScenario(principal, row)) throw httpError(403, 'Це не ваш сценарій');
  return row.image_url;
}

router.post('/api/scenarios/:id/preview', authorize('author'), requireScenarioEditor, receivePreview, async (req, res) => {
  try {
    if (!req.file) throw httpError(400, 'Очікується файл у полі "preview"');
    const { id } = req.params;
    const info = inspectPreview(req.file.buffer);
    const stored = await storage.commitPreview(req.file.buffer, info.ext);

    await inTransaction(async db => {
      const previous = await lockEditable(db, id, req.principal);
      await db.query('UPDATE scenarios SET image_url = $2, updated_at = NOW() WHERE id = $1', [id, stored.url]);
      await audit.record(db, req.principal, 'scenario.preview', id, {
        imageUrl: stored.url, bytes: stored.bytes, width: info.width, height: info.height,
        deduplicated: stored.deduplicated, previous,
      });
    });

    res.json({ imageUrl: stored.url, warnings: info.warnings });
  } catch (err) {
    sendError(res, err, 'POST /api/scenarios/:id/preview');
  }
});

router.delete('/api/scenarios/:id/preview', authorize('author'), requireScenarioEditor, async (req, res) => {
  try {
    const { id } = req.params;
    await inTransaction(async db => {
      const previous = await lockEditable(db, id, req.principal);
      if (previous === '') return;
      await db.query("UPDATE scenarios SET image_url = '', updated_at = NOW() WHERE id = $1", [id]);
      await audit.record(db, req.principal, 'scenario.preview.remove', id, { previous });
    });
    res.json({ message: 'Зображення прибрано', imageUrl: '' });
  } catch (err) {
    sendError(res, err, 'DELETE /api/scenarios/:id/preview');
  }
});

module.exports = { router };
