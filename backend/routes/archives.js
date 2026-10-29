// backend/routes/archives.js
//
// Archive intake - content-addressed storage. Two ways in: an upload into an existing
// scenario (it lands in the version history per the scenario's status), and `from-archive`,
// which creates the draft from the archive's own manifest.

const express = require('express');
const multer = require('multer');

const { pool, inTransaction } = require('../db');
const { authorize, canEditScenario } = require('../auth');
const { limitAuthorUploads } = require('../rate-limits');
const audit = require('../audit');
const { MAX_ARCHIVE_BYTES } = require('../config');
const storage = require('../storage');
const { validateScenarioArchive } = require('../archive-validation');
const { checksFromValidation } = require('../archive-checks');
const { fetchAdminRow } = require('../scenario-rows');
const versions = require('../versions');
const { httpError } = require('../http-error');
const { SCENARIO_ID_PATTERN } = require('../catalog-input');

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

/**
 * Wraps an archive-receiving route: `ingest({ req, file, commit })` returns `{ status, body }`
 * or throws. `commit()` stores the temp file in the object store (renaming or deleting it);
 * every other exit - including an early 404 - must not leak the temp file, so it is
 * discarded here unless `commit` took it. That happens before the response, not after:
 * a client that reacts to the response may look at the temp dir.
 */
function archiveRoute(tag, ingest) {
  return async (req, res) => {
    const file = req.file?.path;
    let consumed = false;
    const commit = async () => {
      const result = await storage.commitArchive(file);
      consumed = true;
      return result;
    };

    let outcome;
    try {
      outcome = await ingest({ req, file, commit });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(`[ARCHIVE] ${tag} error:`, err.message);
      outcome = { status, body: { error: status === 500 ? 'Помилка сервера' : err.message } };
    } finally {
      if (!consumed) await storage.discardTemp(file);
    }
    res.status(outcome.status).json(outcome.body);
  };
}

const NO_FILE = { status: 400, body: { error: 'Очікується файл у полі "archive"' } };

/**
 * POST /api/scenarios/:id/archive   (author who owns it, or moderator; multipart field "archive")
 *
 * Stores the upload as /scenarios/<sha256>.zip and records it in the scenario's version
 * history (`versions.installUpload`): a new current version, or - for an author on a
 * published scenario - a pending one students do not see until a moderator accepts it.
 * Identical content uploaded twice reuses the same object. Author uploads are
 * rate-limited per key (`limitAuthorUploads`) before the body is read.
 */
router.post('/api/scenarios/:id/archive', authorize('author'), limitAuthorUploads, receiveArchive,
  archiveRoute('upload', async ({ req, file, commit }) => {
    const { id } = req.params;
    const { principal } = req;
    if (!file) return NO_FILE;
    console.log(`[ARCHIVE] ${id}: прийнято файл ${req.file.originalname} (${req.file.size} bytes)`);

    // An unlocked look first, so a refusal costs no validation; the transaction below repeats
    // every check under the row lock, which is the one that counts.
    const { rows } = await pool.query('SELECT owner_key_id, status FROM scenarios WHERE id = $1', [id]);
    if (!rows[0]) return { status: 404, body: { error: 'Сценарій не знайдено' } };
    if (!canEditScenario(principal, rows[0])) return { status: 403, body: { error: 'Це не ваш сценарій' } };
    if (rows[0].status === 'review') {
      throw httpError(409, 'Сценарій на перевірці: відкличте з перевірки, щоб завантажити новий архів');
    }

    // Validate before committing — a broken archive must never enter the store.
    const validated = await validateScenarioArchive(file, id);
    const { manifest, warnings } = validated;
    console.log(`[ARCHIVE] ${id}: маніфест прочитано (id="${manifest.id}", version=${manifest.version})`);
    for (const warning of warnings) console.log(`[ARCHIVE] ${id}: попередження — ${warning}`);

    const result = await commit();
    console.log(`[ARCHIVE] ${id}: sha256=${result.sha256} ${result.deduplicated ? '(вже є в сховищі, дедуп)' : '(новий об\'єкт збережено)'}`);

    const installed = await inTransaction(async db => {
      // Owner and status are read under the lock: a concurrent approve cannot let an
      // author's upload land as `current` on a row that has just become published.
      const { rows: [row] } = await db.query(
        'SELECT id, owner_key_id, status FROM scenarios WHERE id = $1 FOR UPDATE', [id]
      );
      if (!row) throw httpError(404, 'Сценарій не знайдено');
      if (!canEditScenario(principal, row)) throw httpError(403, 'Це не ваш сценарій');

      const outcome = await versions.installUpload(db, row, principal, result, manifest,
        checksFromValidation(validated, result.bytes));
      await audit.record(db, principal, 'scenario.archive', id, {
        sha256: result.sha256, bytes: result.bytes, deduplicated: result.deduplicated,
        state: outcome.state, versionId: outcome.version.id,
      });
      return outcome;
    });
    console.log(`[ARCHIVE] ${id}: версія ${installed.version.id} (${installed.state}) → ${result.url} (${result.bytes} bytes)`);

    return {
      status: 201,
      body: { id, ...result, manifestId: manifest.id, warnings, version: installed.version },
    };
  }));

const clip = (value, max) => String(value).slice(0, max);

/**
 * POST /api/scenarios/from-archive   (author or moderator; multipart field "archive",
 * optional text field "category" - an existing slug, defaulting to the first category)
 *
 * Creates a **draft** from the archive's own manifest: id = manifest id (a slug, else 400
 * with a hint to rebuild; 409 when taken), title/description/version from the manifest,
 * owned by the caller, the archive as its current version. Nothing is left behind on a
 * refusal: the row and the version are one transaction, and an invalid ZIP never reaches
 * the store. Counts toward the author upload limit like any upload.
 */
router.post('/api/scenarios/from-archive', authorize('author'), limitAuthorUploads, receiveArchive,
  archiveRoute('from-archive', async ({ req, file, commit }) => {
    const { principal } = req;
    if (!file) return NO_FILE;

    const validated = await validateScenarioArchive(file, null);
    const { manifest, entries, warnings } = validated;

    // The id comes from untrusted manifest data and becomes a catalog id and a URL segment.
    if (typeof manifest.id !== 'string' || !SCENARIO_ID_PATTERN.test(manifest.id)) {
      throw httpError(400, `Ідентифікатор у manifest.json ("${clip(manifest.id, 60)}") не підходить для каталогу: `
        + 'потрібен slug із 2–100 символів a-z, 0-9 та "-". Зберіть архів за допомогою ScenarioCreator.');
    }
    const id = manifest.id;

    const requested = req.body?.category;
    if (requested !== undefined && (typeof requested !== 'string' || !requested.trim())) {
      throw httpError(400, 'category має бути непорожнім рядком');
    }
    const { rows: categories } = await pool.query(
      'SELECT slug, label FROM categories WHERE ($1::text IS NULL OR slug = $1) ORDER BY sort_order, slug LIMIT 1',
      [requested?.trim() ?? null]
    );
    if (!categories[0]) {
      throw httpError(400, requested === undefined ? 'У каталозі немає жодної категорії' : 'Невідома категорія');
    }

    if ((await pool.query('SELECT 1 FROM scenarios WHERE id = $1', [id])).rowCount) {
      throw httpError(409, `Сценарій з id "${id}" вже існує`);
    }

    const result = await commit();
    const description = typeof manifest.description === 'string' ? manifest.description : '';

    let installed;
    try {
      installed = await inTransaction(async db => {
        await db.query(`
          INSERT INTO scenarios
            (id, title, description, full_description, category, category_label, version, author, owner_key_id)
          VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)
        `, [
          id, clip(manifest.name, 255), description, categories[0].slug, categories[0].label,
          clip(manifest.version, 20),
          principal.keyId == null ? null : principal.label,
          principal.keyId,
        ]);
        await audit.record(db, principal, 'scenario.create', id, { category: categories[0].slug, source: 'archive' });

        const outcome = await versions.installUpload(db, { id, status: 'draft' }, principal, result, manifest,
          checksFromValidation(validated, result.bytes));
        await audit.record(db, principal, 'scenario.archive', id, {
          sha256: result.sha256, bytes: result.bytes, deduplicated: result.deduplicated,
          state: outcome.state, versionId: outcome.version.id,
        });
        return { ...outcome, scenario: await fetchAdminRow(db, id) };
      });
    } catch (err) {
      // A concurrent create of the same id passed the check above and lost the race.
      if (err.code === '23505') throw httpError(409, `Сценарій з id "${id}" вже існує`);
      throw err;
    }
    console.log(`[ARCHIVE] from-archive ${id}: чернетку створено, версія ${installed.version.id}`);

    return {
      status: 201,
      body: {
        scenario: installed.scenario,
        version: installed.version,
        manifest: {
          id, name: manifest.name, version: manifest.version, entryPoint: manifest.entryPoint,
          resourceCount: entries.filter(name => !name.endsWith('/')).length,
          engineVersion: manifest.engineVersion ?? null,
        },
        warnings,
      },
    };
  }));

module.exports = { router };
