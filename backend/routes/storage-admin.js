// backend/routes/storage-admin.js
//
// Reporting on the object stores (archives and cover previews) and garbage-collecting them.

const express = require('express');

const { pool, inTransaction } = require('../db');
const { authorize } = require('../auth');
const audit = require('../audit');
const storage = require('../storage');

const router = express.Router();

/**
 * How recently an object may have been written and still be swept.
 *
 * `commitArchive` stores an object before the row pointing at it is updated, so
 * a new object is unreferenced for a moment by design. Anything younger than
 * this is left alone rather than raced.
 */
const GC_MIN_AGE_MS = Number(process.env.GC_MIN_AGE_MS || 60 * 60 * 1000);

/**
 * Every archive hash something still points at: a scenario's own archive and every version
 * row (current, pending or archived). A version row is a reference until it is deleted; the
 * scenario's column mirrors its current version, so the union only differs for a row that
 * predates the history.
 */
async function referencedArchives() {
  const { rows } = await pool.query(`
    SELECT archive_sha256 AS sha256 FROM scenarios WHERE archive_sha256 IS NOT NULL
    UNION
    SELECT sha256 FROM scenario_versions
  `);
  return new Set(rows.map(row => row.sha256));
}

/**
 * Every preview hash a catalog row's `imageUrl` still points at. A preview has exactly one kind
 * of reference (the row's cover); an orphan is one nobody uploaded to a row, or one replaced.
 */
async function referencedPreviews() {
  const { rows } = await pool.query("SELECT image_url FROM scenarios WHERE image_url LIKE '/previews/%'");
  return new Set(rows.map(row => storage.previewHashOf(row.image_url)).filter(Boolean));
}

/** Both stores classified at once: `{ archives, previews }`, each `{ referenced, orphans, tooNew }`. */
async function classifyBoth() {
  const [archives, previews] = await Promise.all([referencedArchives(), referencedPreviews()]);
  return {
    archives: await storage.archives.classifyObjects(archives, GC_MIN_AGE_MS),
    previews: await storage.previews.classifyObjects(previews, GC_MIN_AGE_MS),
  };
}

const sumBytes = objects => objects.reduce((total, o) => total + o.bytes, 0);

const summarise = objects => ({ count: objects.length, bytes: sumBytes(objects) });

/** The report for one store. */
function describe({ referenced, orphans, tooNew }) {
  return {
    total: summarise([...referenced, ...orphans, ...tooNew]),
    referenced: summarise(referenced),
    orphans: {
      ...summarise(orphans),
      // Enough to recognise them without turning this into a directory dump.
      sample: [...orphans]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 20)
        .map(o => ({ sha256: o.sha256, bytes: o.bytes })),
    },
    // Unreferenced but too recent to touch — an upload mid-flight looks
    // exactly like an orphan, so say so rather than hiding the difference.
    protectedByAge: summarise(tooNew),
  };
}

/**
 * GET /api/admin/storage   (moderator)
 *
 * What is in the archive store - and, under `previews`, the cover-image store - and how much of
 * it nothing refers to. Read-only on purpose: the
 * roadmap's rule is to report reclaimable bytes before deleting anything, so seeing the number
 * never costs you the files.
 */
router.get('/api/admin/storage', authorize('moderator'), async (req, res) => {
  try {
    const { archives, previews } = await classifyBoth();

    // The archive store keeps its original top-level shape; the preview store is `previews`.
    res.json({ ...describe(archives), minAgeMs: GC_MIN_AGE_MS, previews: describe(previews) });
  } catch (err) {
    console.error('[STORAGE] report error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

/**
 * POST /api/admin/storage/gc   (moderator)   { dryRun?: boolean }
 *
 * Deletes objects no catalog row references. **Dry run unless asked otherwise**
 * — an accidental POST reports instead of deleting, which is the right default
 * for the only endpoint here that destroys data.
 *
 * Deliberately not automatic on scenario delete: deduplication means an object
 * may back several rows, and a mistaken delete stays recoverable while its
 * archive is still on disk.
 */
router.post('/api/admin/storage/gc', authorize('moderator'), async (req, res) => {
  const dryRun = req.body?.dryRun !== false;

  try {
    const { archives, previews } = await classifyBoth();

    if (dryRun) {
      return res.json({
        dryRun: true,
        wouldDelete: summarise(archives.orphans), protectedByAge: summarise(archives.tooNew),
        previews: { wouldDelete: summarise(previews.orphans), protectedByAge: summarise(previews.tooNew) },
      });
    }

    const [deletedArchives, deletedPreviews] = [
      await storage.archives.deleteObjects(archives.orphans),
      await storage.previews.deleteObjects(previews.orphans),
    ];
    console.log(`[STORAGE] gc removed ${deletedArchives.length} archive(s), ${sumBytes(deletedArchives)} bytes, `
      + `${deletedPreviews.length} preview(s), ${sumBytes(deletedPreviews)} bytes`);
    // A dry run changes nothing and is not journalled; a sweep is.
    await inTransaction(db => audit.record(db, req.principal, 'storage.gc', null, {
      ...summarise(deletedArchives), previews: summarise(deletedPreviews),
    }));

    res.json({
      dryRun: false,
      deleted: summarise(deletedArchives), protectedByAge: summarise(archives.tooNew),
      previews: { deleted: summarise(deletedPreviews), protectedByAge: summarise(previews.tooNew) },
    });
  } catch (err) {
    console.error('[STORAGE] gc error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

module.exports = { router };
