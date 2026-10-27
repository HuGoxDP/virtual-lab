// backend/routes/categories.js
//
// Category management. Reading is for any signed-in principal (an author picks from the list,
// hidden categories flagged); every mutation is a moderator's.
//
//   GET    /api/categories              any principal
//   POST   /api/categories              moderator   { slug, label, icon?, isVisible? } -> 201
//   PUT    /api/categories/:slug        moderator   { label?, icon?, isVisible? }
//   DELETE /api/categories/:slug        moderator   409 while any scenario uses it
//   POST   /api/categories/reorder      moderator   { slugs } - every slug exactly once
//
// Hiding a category is the soft form of removal: its scenarios stay as they are but every
// public endpoint treats them as unpublished (`PUBLIC_ROW` in catalog-public.js).

const express = require('express');

const { pool, inTransaction } = require('../db');
const { authorize } = require('../auth');
const audit = require('../audit');
const { validateCategory } = require('../catalog-input');
const { httpError, sendError } = require('../http-error');

const router = express.Router();

const COLUMNS = `
  c.slug, c.label, c.icon, c.sort_order AS "sortOrder", c.is_visible AS "isVisible"
`;

/** One category, or undefined. */
async function fetchCategory(db, slug) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM categories c WHERE c.slug = $1`, [slug]);
  return rows[0];
}

// `scenarioCount` (every status) is a moderator's number: an author must not learn how many
// drafts other people have.
router.get('/api/categories', authorize('author'), async (req, res) => {
  try {
    const withCount = req.principal.role === 'moderator';
    const { rows } = await pool.query(`
      SELECT ${COLUMNS}
             ${withCount ? ', (SELECT COUNT(*)::int FROM scenarios s WHERE s.category = c.slug) AS "scenarioCount"' : ''}
        FROM categories c
       ORDER BY c.sort_order, c.slug
    `);
    res.json({ categories: rows });
  } catch (err) {
    sendError(res, err, 'GET /api/categories');
  }
});

router.post('/api/categories', authorize('moderator'), async (req, res) => {
  const checked = validateCategory(req.body, { create: true });
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { slug, label, icon, isVisible = true } = checked.value;

  try {
    const category = await inTransaction(async db => {
      await db.query(`
        INSERT INTO categories (slug, label, icon, sort_order, is_visible)
        VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM categories), $4)
      `, [slug, label, icon, isVisible]);
      await audit.record(db, req.principal, 'category.create', null, { slug, label, icon, isVisible });
      return fetchCategory(db, slug);
    });
    res.status(201).json({ category });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Категорія "${slug}" вже існує` });
    sendError(res, err, 'POST /api/categories');
  }
});

router.post('/api/categories/reorder', authorize('moderator'), async (req, res) => {
  const { slugs } = req.body ?? {};
  if (!Array.isArray(slugs) || slugs.some(slug => typeof slug !== 'string') || new Set(slugs).size !== slugs.length) {
    return res.status(400).json({ error: 'slugs має бути масивом унікальних рядків' });
  }

  try {
    await inTransaction(async db => {
      const { rows } = await db.query('SELECT slug FROM categories FOR UPDATE');
      const existing = new Set(rows.map(row => row.slug));
      if (existing.size !== slugs.length || slugs.some(slug => !existing.has(slug))) {
        throw httpError(409, 'Список категорій змінився: оновіть сторінку та повторіть');
      }
      await db.query(`
        UPDATE categories SET sort_order = t.position * 10
          FROM unnest($1::text[]) WITH ORDINALITY AS t(slug, position)
         WHERE categories.slug = t.slug
      `, [slugs]);
      await audit.record(db, req.principal, 'category.reorder', null, { slugs });
    });
    const { rows } = await pool.query(`SELECT ${COLUMNS} FROM categories c ORDER BY c.sort_order, c.slug`);
    res.json({ categories: rows });
  } catch (err) {
    sendError(res, err, 'POST /api/categories/reorder');
  }
});

router.put('/api/categories/:slug', authorize('moderator'), async (req, res) => {
  const checked = validateCategory(req.body, { create: false });
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { label, icon, isVisible } = checked.value;
  const { slug } = req.params;

  try {
    const category = await inTransaction(async db => {
      const { rowCount } = await db.query(`
        UPDATE categories
           SET label      = COALESCE($2::text, label),
               icon       = COALESCE($3::text, icon),
               is_visible = COALESCE($4::boolean, is_visible)
         WHERE slug = $1
      `, [slug, label ?? null, icon ?? null, isVisible ?? null]);
      if (!rowCount) throw httpError(404, 'Категорію не знайдено');

      // The admin listing reads the scenario's own copy of the label; keep it in step.
      if (label !== undefined) await db.query('UPDATE scenarios SET category_label = $2 WHERE category = $1', [slug, label]);
      await audit.record(db, req.principal, 'category.update', null, { slug, ...checked.value });
      return fetchCategory(db, slug);
    });
    res.json({ category });
  } catch (err) {
    sendError(res, err, 'PUT /api/categories/:slug');
  }
});

router.delete('/api/categories/:slug', authorize('moderator'), async (req, res) => {
  const { slug } = req.params;
  try {
    await inTransaction(async db => {
      const { rows } = await db.query('SELECT slug FROM categories WHERE slug = $1 FOR UPDATE', [slug]);
      if (!rows[0]) throw httpError(404, 'Категорію не знайдено');

      const { rows: [{ used }] } = await db.query('SELECT COUNT(*)::int AS used FROM scenarios WHERE category = $1', [slug]);
      if (used > 0) throw httpError(409, `Категорія використовується (сценаріїв: ${used}): перенесіть їх або приховайте категорію`);

      await db.query('DELETE FROM categories WHERE slug = $1', [slug]);
      await audit.record(db, req.principal, 'category.delete', null, { slug });
    });
    res.json({ message: 'Категорію видалено', slug });
  } catch (err) {
    sendError(res, err, 'DELETE /api/categories/:slug');
  }
});

module.exports = { router };
