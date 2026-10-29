// backend/routes/catalog-admin.js
//
// Catalog mutation and the admin listing: the routes whoever curates the
// catalog uses. An author works on their own scenarios' content; a moderator
// (a personal key or the bootstrap token) on everything.

const express = require('express');

const { pool, inTransaction } = require('../db');
const { authorize, canEditScenario } = require('../auth');
const audit = require('../audit');
const { validateFeatures, forbiddenAuthorFields, imageUrlProblem, scenarioTextProblem } = require('../catalog-input');
const { ADMIN_COLUMNS } = require('../scenario-rows');
const { applyTransition } = require('../workflow');
const { httpError, sendError } = require('../http-error');

const router = express.Router();

const isAuthor = principal => principal.role === 'author';

const forbiddenFieldsError = fields => ({
  error: `Автору заборонено поля: ${fields.join(', ')}`,
});

async function categoryExists(db, slug) {
  const { rowCount } = await db.query('SELECT 1 FROM categories WHERE slug = $1', [slug]);
  return rowCount > 0;
}

// ── GET /api/admin/scenarios ─────────────────────────
// Everything the catalog hides: unpublished rows, storage state, archive
// metadata. An author sees only the rows their key owns; a moderator, all.
router.get('/api/admin/scenarios', authorize('author'), async (req, res) => {
  const { principal } = req;

  try {
    const { rows } = await pool.query(`
      SELECT ${ADMIN_COLUMNS}
      FROM scenarios
      WHERE ($1::int IS NULL OR owner_key_id = $1)
      ORDER BY created_at DESC
    `, [isAuthor(principal) ? principal.keyId : null]);

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
// Every new row starts as `draft` - it has no archive yet, and approving needs one - whatever
// the caller sends (`isPublished` is ignored for a moderator, refused for an author). Author:
// owned by the key, `author` = the key's label, `category` must already exist. Moderator: an
// unknown slug creates its category from `categoryLabel`.
router.post('/api/catalog', authorize('author'), async (req, res) => {
  const { principal } = req;
  const byAuthor = isAuthor(principal);

  if (byAuthor) {
    const forbidden = forbiddenAuthorFields(req.body);
    if (forbidden.length) return res.status(400).json(forbiddenFieldsError(forbidden));
  }

  const {
    id, title, description, fullDescription,
    category, categoryLabel, imageUrl, scenarioUrl,
    version, author, features,
  } = req.body;

  if (!id || !title || !category || (!byAuthor && !categoryLabel)) {
    return res.status(400).json({
      error: byAuthor
        ? 'Обов\'язкові поля: id, title, category'
        : 'Обов\'язкові поля: id, title, category, categoryLabel',
    });
  }

  const textProblem = scenarioTextProblem(req.body);
  if (textProblem) return res.status(400).json({ error: textProblem });
  const checked = features === undefined ? { value: [] } : validateFeatures(features);
  if (checked.error) return res.status(400).json({ error: checked.error });
  // (An author's imageUrl was refused above.) A new row has no cover yet.
  const imageProblem = imageUrl === undefined ? null : imageUrlProblem(imageUrl, '');
  if (imageProblem) return res.status(400).json({ error: imageProblem });

  try {
    if (byAuthor && (typeof category !== 'string' || !(await categoryExists(pool, category)))) {
      return res.status(400).json({ error: 'Невідома категорія' });
    }

    const created = await inTransaction(async db => {
      if (!byAuthor) await ensureCategory(db, category, categoryLabel);
      const { rows } = await db.query(`
        INSERT INTO scenarios
        (id, title, description, full_description, category, category_label,
         image_url, scenario_url, version, author, features, owner_key_id)
        VALUES ($1,$2,$3,$4,$5,
                COALESCE($6::text, (SELECT label FROM categories WHERE slug = $13::text)),
                $7,$8,$9,$10,$11::jsonb,$12)
          RETURNING id
      `, [
        id, title,
        description || '', fullDescription || '',
        category,
        // An author's `categoryLabel` is ignored: the category's own label stands in.
        byAuthor ? null : categoryLabel,
        imageUrl || '', scenarioUrl || '',
        version || '1.0.0',
        // `author` is a display name: an author key is its own label; a moderator
        // names it, defaulting to their key's label (the bootstrap has none).
        byAuthor ? principal.label : (author || (principal.keyId == null ? null : principal.label)),
        JSON.stringify(checked.value),
        principal.keyId,
        category,
      ]);
      await audit.record(db, principal, 'scenario.create', rows[0].id, { category });
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
// Обновить существующий сценарий. A moderator may send any field; the owning
// author only content fields (`category` an existing slug, `categoryLabel` ignored).
router.put('/api/catalog/:id', authorize('author'), async (req, res) => {
  const { id } = req.params;
  const { principal } = req;
  const byAuthor = isAuthor(principal);

  if (byAuthor) {
    const forbidden = forbiddenAuthorFields(req.body);
    if (forbidden.length) return res.status(400).json(forbiddenFieldsError(forbidden));
  }

  const {
    title, description, fullDescription,
    category, imageUrl, scenarioUrl, manifestUrl,
    version, author, isPublished, features,
  } = req.body;
  const categoryLabel = byAuthor ? undefined : req.body.categoryLabel;

  const textProblem = scenarioTextProblem({ ...req.body, id: undefined });
  if (textProblem) return res.status(400).json({ error: textProblem });
  const checked = features === undefined ? null : validateFeatures(features);
  if (checked?.error) return res.status(400).json({ error: checked.error });
  if (category !== undefined && (typeof category !== 'string' || !category)) {
    return res.status(400).json({ error: 'category має бути непорожнім рядком' });
  }
  if (categoryLabel !== undefined && typeof categoryLabel !== 'string') {
    return res.status(400).json({ error: 'categoryLabel має бути рядком' });
  }
  if (isPublished !== undefined && typeof isPublished !== 'boolean') {
    return res.status(400).json({ error: 'isPublished має бути булевим' });
  }

  // Собираем только те поля, которые пришли в запросе
  const fields = [];
  const values = [];
  const changed = [];
  let paramIndex = 1;

  const addField = (name, column, value) => {
    if (value !== undefined) {
      fields.push(`${column} = $${paramIndex++}`);
      values.push(value);
      changed.push(name);
    }
  };

  addField('title', 'title', title);
  addField('description', 'description', description);
  addField('fullDescription', 'full_description', fullDescription);
  addField('category', 'category', category);
  addField('categoryLabel', 'category_label', categoryLabel);
  addField('imageUrl', 'image_url', imageUrl);
  addField('scenarioUrl', 'scenario_url', scenarioUrl);
  // Null clears it — a scenario whose manifest was withdrawn must be able to
  // fall back to its ZIP rather than keep pointing at a store entry that is gone.
  addField('manifestUrl', 'manifest_url', manifestUrl);
  addField('version', 'version', version);
  addField('author', 'author', author);
  if (checked) {
    fields.push(`features = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(checked.value));
    changed.push('features');
  }

  if (fields.length === 0 && isPublished === undefined) {
    return res.status(400).json({ error: 'Не вказано жодного поля для оновлення' });
  }

  // Автоматически обновляем updated_at
  fields.push(`updated_at = NOW()`);

  try {
    values.push(id); // последний параметр — WHERE id = $N
    await inTransaction(async db => {
      // Locked, so the ownership read below cannot go stale before the write.
      const { rows } = await db.query('SELECT owner_key_id, status, image_url FROM scenarios WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) throw httpError(404, 'Сценарій не знайдено');
      if (!canEditScenario(principal, rows[0])) throw httpError(403, 'Це не ваш сценарій');
      if (imageUrl !== undefined) {
        const problem = imageUrlProblem(imageUrl, rows[0].image_url);
        if (problem) throw httpError(400, problem);
      }

      // Compatibility for the old admin: `isPublished` is approve / unpublish. Asking for the
      // state the row is already in is a no-op; approving a row with no archive is a 409.
      // Done before any write, so a refusal changes nothing.
      if (isPublished === true && rows[0].status !== 'published') {
        await applyTransition(db, principal, id, 'approve');
      } else if (isPublished === false && rows[0].status === 'published') {
        await applyTransition(db, principal, id, 'unpublish');
      }

      if (category !== undefined) {
        if (!byAuthor) await ensureCategory(db, category, categoryLabel);
        else if (!(await categoryExists(db, category))) throw httpError(400, 'Невідома категорія');
      }

      if (changed.length > 0) {
        await db.query(`UPDATE scenarios SET ${fields.join(', ')} WHERE id = $${paramIndex}`, values);
        await audit.record(db, principal, 'scenario.update', id, { fields: changed });
      }
    });

    res.json({ message: 'Сценарій оновлено', id });
  } catch (err) {
    sendError(res, err, 'PUT /api/catalog/:id');
  }
});

// ── DELETE /api/catalog/:id ──────────────────────────
router.delete('/api/catalog/:id', authorize('moderator'), async (req, res) => {
  try {
    const rowCount = await inTransaction(async db => {
      const result = await db.query('DELETE FROM scenarios WHERE id = $1', [req.params.id]);
      if (result.rowCount) await audit.record(db, req.principal, 'scenario.delete', req.params.id);
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
