// backend/routes/storage-admin.js
//
// Reporting on the archive store and garbage-collecting it.

const express = require('express');

const { pool } = require('../db');
const { requireAdmin } = require('../auth');
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

/** Every archive hash the catalog still points at. */
async function referencedArchives() {
  const { rows } = await pool.query(
    'SELECT DISTINCT archive_sha256 FROM scenarios WHERE archive_sha256 IS NOT NULL'
  );
  return new Set(rows.map(row => row.archive_sha256));
}

const sumBytes = objects => objects.reduce((total, o) => total + o.bytes, 0);

const summarise = objects => ({ count: objects.length, bytes: sumBytes(objects) });

/**
 * GET /api/admin/storage   (admin)
 *
 * What is in the archive store and how much of it nothing refers to. Read-only
 * on purpose: the roadmap's rule is to report reclaimable bytes before deleting
 * anything, so seeing the number never costs you the files.
 */
router.get('/api/admin/storage', requireAdmin, async (req, res) => {
  try {
    const { referenced, orphans, tooNew } = await storage.classifyObjects(
      await referencedArchives(), GC_MIN_AGE_MS
    );

    res.json({
      total: summarise([...referenced, ...orphans, ...tooNew]),
      referenced: summarise(referenced),
      orphans: {
        ...summarise(orphans),
        // Enough to recognise them without turning this into a directory dump.
        sample: orphans
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 20)
          .map(o => ({ sha256: o.sha256, bytes: o.bytes })),
      },
      // Unreferenced but too recent to touch — an upload mid-flight looks
      // exactly like an orphan, so say so rather than hiding the difference.
      protectedByAge: summarise(tooNew),
      minAgeMs: GC_MIN_AGE_MS,
    });
  } catch (err) {
    console.error('[STORAGE] report error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

/**
 * POST /api/admin/storage/gc   (admin)   { dryRun?: boolean }
 *
 * Deletes objects no catalog row references. **Dry run unless asked otherwise**
 * — an accidental POST reports instead of deleting, which is the right default
 * for the only endpoint here that destroys data.
 *
 * Deliberately not automatic on scenario delete: deduplication means an object
 * may back several rows, and a mistaken delete stays recoverable while its
 * archive is still on disk.
 */
router.post('/api/admin/storage/gc', requireAdmin, async (req, res) => {
  const dryRun = req.body?.dryRun !== false;

  try {
    const { orphans, tooNew } = await storage.classifyObjects(
      await referencedArchives(), GC_MIN_AGE_MS
    );

    if (dryRun) {
      return res.json({ dryRun: true, wouldDelete: summarise(orphans), protectedByAge: summarise(tooNew) });
    }

    const deleted = await storage.deleteObjects(orphans);
    console.log(`[STORAGE] gc removed ${deleted.length} object(s), ${sumBytes(deleted)} bytes`);

    res.json({ dryRun: false, deleted: summarise(deleted), protectedByAge: summarise(tooNew) });
  } catch (err) {
    console.error('[STORAGE] gc error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

module.exports = { router };
