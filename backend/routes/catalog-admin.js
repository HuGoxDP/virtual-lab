// backend/routes/catalog-admin.js
//
// Catalog mutation and the admin listing: the routes whoever curates the
// catalog uses.

const express = require('express');

const { pool, inTransaction } = require('../db');
const { requireAdmin } = require('../auth');
const { validateFeatures } = require('../catalog-input');

const router = express.Router();

// ── GET /api/admin/scenarios ─────────────────────────
// Everything the catalog hides: unpublished rows, storage state, archive
// metadata. `is_published` was previously only reachable through raw SQL.
router.get('/api/admin/scenarios', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id, title, description,
        full_description   AS "fullDescription",
        category,
        category_label     AS "categoryLabel",
        image_url          AS "imageUrl",
        scenario_url       AS "scenarioUrl",
        manifest_url       AS "manifestUrl",
        version, author,
        upload_date        AS "uploadDate",
        is_published       AS "isPublished",
        storage_kind       AS "storageKind",
        archive_sha256     AS "archiveSha256",
        archive_bytes      AS "archiveBytes",
        manifest_id        AS "manifestId",
        manifest_version   AS "manifestVersion",
        manifest_engine_version AS "manifestEngineVersion",
        updated_at         AS "updatedAt",
        CASE WHEN jsonb_typeof(features) = 'array' THEN features ELSE '[]'::jsonb END AS features
      FROM scenarios
      ORDER BY created_at DESC
    `);

    res.json({ scenarios: rows });
  } catch (err) {
    console.error('[API] GET /api/admin/scenarios error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

/**
 * Makes sure a category row exists for `slug`, appended after the last one.
 * A known slug keeps its stored label; with no label the slug stands in.
 */
async function ensureCategory(db, slug, label) {
  await db.query(`
    INSERT INTO categories (slug, label, icon, sort_order)
    VALUES ($1, $2, 'folder', (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM categories))
    ON CONFLICT (slug) DO NOTHING
  `, [slug, label || slug]);
}

// ── POST /api/catalog ────────────────────────────────
router.post('/api/catalog', requireAdmin, async (req, res) => {
  const {
    id, title, description, fullDescription,
    category, categoryLabel, imageUrl, scenarioUrl,
    version, author, features,
  } = req.body;

  if (!id || !title || !category || !categoryLabel) {
    return res.status(400).json({
      error: 'Обов\'язкові поля: id, title, category, categoryLabel',
    });
  }

  const checked = features === undefined ? { value: [] } : validateFeatures(features);
  if (checked.error) return res.status(400).json({ error: checked.error });

  try {
    const created = await inTransaction(async db => {
      await ensureCategory(db, category, categoryLabel);
      const { rows } = await db.query(`
        INSERT INTO scenarios
        (id, title, description, full_description, category, category_label,
         image_url, scenario_url, version, author, features)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
          RETURNING id
      `, [
        id, title,
        description || '', fullDescription || '',
        category, categoryLabel,
        imageUrl || '', scenarioUrl || '',
        version || '1.0.0', author || null,
        JSON.stringify(checked.value),
      ]);
      return rows[0];
    });

    res.status(201).json({ id: created.id, message: 'Сценарій додано' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `Сценарій з id "${id}" вже існує` });
    }
    console.error('[API] POST /api/catalog error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── PUT /api/catalog/:id ─────────────────────────────
// Обновить существующий сценарий (любые поля)
router.put('/api/catalog/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    title, description, fullDescription,
    category, categoryLabel, imageUrl, scenarioUrl, manifestUrl,
    version, author, isPublished, features,
  } = req.body;

  const checked = features === undefined ? null : validateFeatures(features);
  if (checked?.error) return res.status(400).json({ error: checked.error });
  if (category !== undefined && (typeof category !== 'string' || !category)) {
    return res.status(400).json({ error: 'category має бути непорожнім рядком' });
  }
  if (categoryLabel !== undefined && typeof categoryLabel !== 'string') {
    return res.status(400).json({ error: 'categoryLabel має бути рядком' });
  }

  // Собираем только те поля, которые пришли в запросе
  const fields = [];
  const values = [];
  let paramIndex = 1;

  const addField = (column, value) => {
    if (value !== undefined) {
      fields.push(`${column} = $${paramIndex++}`);
      values.push(value);
    }
  };

  addField('title', title);
  addField('description', description);
  addField('full_description', fullDescription);
  addField('category', category);
  addField('category_label', categoryLabel);
  addField('image_url', imageUrl);
  addField('scenario_url', scenarioUrl);
  // Null clears it — a scenario whose manifest was withdrawn must be able to
  // fall back to its ZIP rather than keep pointing at a store entry that is gone.
  addField('manifest_url', manifestUrl);
  addField('version', version);
  addField('author', author);
  addField('is_published', isPublished);
  if (checked) {
    fields.push(`features = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(checked.value));
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'Не вказано жодного поля для оновлення' });
  }

  // Автоматически обновляем updated_at
  fields.push(`updated_at = NOW()`);

  try {
    values.push(id); // последний параметр — WHERE id = $N
    const rowCount = await inTransaction(async db => {
      // Create the category only when the row exists, so a 404 leaves nothing behind.
      if (category !== undefined && (await db.query('SELECT 1 FROM scenarios WHERE id = $1', [id])).rowCount) {
        await ensureCategory(db, category, categoryLabel);
      }
      const result = await db.query(
        `UPDATE scenarios SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
        values
      );
      return result.rowCount;
    });

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    res.json({ message: 'Сценарій оновлено', id });
  } catch (err) {
    console.error('[API] PUT /api/catalog/:id error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── DELETE /api/catalog/:id ──────────────────────────
router.delete('/api/catalog/:id', requireAdmin, async (req, res) => {
  try {
    const rowCount = await inTransaction(async db => {
      const result = await db.query('DELETE FROM scenarios WHERE id = $1', [req.params.id]);
      return result.rowCount;
    });

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    res.json({ message: 'Сценарій видалено' });
  } catch (err) {
    console.error('[API] DELETE error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

module.exports = { router, ensureCategory };
