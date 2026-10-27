// backend/routes/catalog-public.js
//
// What students and anonymous visitors read: the published catalog and the
// public limits the UI explains itself with.

const express = require('express');

const { pool } = require('../db');
const { optionalAuthenticate, canEditScenario } = require('../auth');
const storage = require('../storage');
const {
  MAX_ARCHIVE_BYTES, PREVIEW_MAX_BYTES, PREVIEW_MIN_WIDTH, PREVIEW_ASPECT,
} = require('../config');

const router = express.Router();

// ── GET /api/catalog ─────────────────────────────────
const CATALOG_DEFAULT_LIMIT = 24;
const CATALOG_MAX_LIMIT = 100;

function parseLimit(raw) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return CATALOG_DEFAULT_LIMIT;
  return Math.min(value, CATALOG_MAX_LIMIT);
}

function parseOffset(raw) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Makes a user's search text safe to wrap in `%…%` for ILIKE.
 *
 * Without this, a query of `%` matches every row and `_` matches any single
 * character — the results stop corresponding to what was typed. (Not an
 * injection risk: the value is still a bound parameter.)
 */
function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, char => `\\${char}`);
}

/**
 * Public item shape shared by the list, the by-id route and `related`.
 *
 * `categories.label` is canonical; the scenario's own label is only the
 * fallback for a slug with no category row. A stored `features` that is not an
 * array reads as `[]`. `archive_bytes` is BIGINT (pg would return a string), so
 * it is cast to float8, which is exact far beyond any archive size.
 */
const ITEM_COLUMNS = `
  s.id,
  s.title,
  s.description,
  s.full_description                      AS "fullDescription",
  s.category,
  COALESCE(c.label, s.category_label)     AS "categoryLabel",
  s.image_url                             AS "imageUrl",
  s.scenario_url                          AS "scenarioUrl",
  s.manifest_url                          AS "manifestUrl",
  s.version,
  s.author,
  s.upload_date                           AS "uploadDate",
  s.archive_bytes::float8                 AS "archiveBytes",
  COALESCE(s.updated_at, s.created_at)    AS "updatedAt",
  CASE WHEN jsonb_typeof(s.features) = 'array' THEN s.features ELSE '[]'::jsonb END AS features
`;

/** How many "related scenarios" the scenario page shows. */
const RELATED_LIMIT = 2;

const ITEM_FROM = 'FROM scenarios s LEFT JOIN categories c ON c.slug = s.category';

/**
 * What every public endpoint may show: published, and not in a hidden category. A slug with no
 * category row (the table has no foreign key on purpose) stays visible. One fragment, so the
 * list, summary, related, by-id and version-preview routes cannot disagree about "unpublished".
 */
const PUBLIC_ROW = "s.status = 'published' AND COALESCE(c.is_visible, true)";

/** Whitelisted ORDER BY fragments: user input only selects a key, it never reaches the SQL text. */
const CATALOG_SORTS = {
  new:   's.created_at DESC, s.id DESC',
  title: 's.title COLLATE "uk-x-icu", s.id',
};

/** Unknown, empty or repeated (`sort[]=a&sort[]=b`) values fall back to newest first. */
function parseSort(raw) {
  return typeof raw === 'string' && Object.hasOwn(CATALOG_SORTS, raw) ? raw : 'new';
}

router.get('/api/catalog', async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const rawCategory = typeof req.query.category === 'string' ? req.query.category : '';
  const category = rawCategory && rawCategory !== 'all' ? rawCategory : null;
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const pattern = query ? `%${escapeLikePattern(query)}%` : null;
  const orderBy = CATALOG_SORTS[parseSort(req.query.sort)];

  // Filtering runs here rather than in the browser: with pagination, a
  // client-side filter would only ever search the page it happens to hold.
  const where = `
    WHERE ${PUBLIC_ROW}
      AND ($1::text IS NULL OR s.category = $1)
      AND (
        $2::text IS NULL
        OR s.title       ILIKE $2 ESCAPE '\\'
        OR s.description ILIKE $2 ESCAPE '\\'
      )
  `;

  try {
    // Categories and summary describe the whole published catalog, not the
    // filtered page — otherwise chips would vanish as soon as one was selected.
    const [scenarios, total, categories, published] = await Promise.all([
      pool.query(`
        SELECT ${ITEM_COLUMNS}
        ${ITEM_FROM}
        ${where}
        ORDER BY ${orderBy}
        LIMIT $3 OFFSET $4
      `, [category, pattern, limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS count ${ITEM_FROM} ${where}`, [category, pattern]),
      pool.query(`
        SELECT
          c.slug           AS category,
          c.label          AS "categoryLabel",
          c.icon,
          COUNT(s.id)::int AS count
        FROM categories c
        JOIN scenarios s ON s.category = c.slug AND s.status = 'published'
        WHERE c.is_visible = true
        GROUP BY c.slug, c.label, c.icon, c.sort_order
        ORDER BY c.sort_order, c.slug
      `),
      pool.query(`SELECT COUNT(*)::int AS count ${ITEM_FROM} WHERE ${PUBLIC_ROW}`),
    ]);

    res.json({
      version: '1',
      scenarios: scenarios.rows,
      categories: categories.rows,
      summary: { scenarios: published.rows[0].count, categories: categories.rows.length },
      total: total.rows[0].count,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[API] GET /api/catalog error:', err.message);
    res.status(500).json({ error: 'Не вдалося завантажити каталог' });
  }
});

// ── GET /api/config ──────────────────────────────────
// Public limits the UI needs to explain itself (the upload form shows the cap).
router.get('/api/config', (req, res) => {
  res.json({
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    preview: { maxBytes: PREVIEW_MAX_BYTES, minWidth: PREVIEW_MIN_WIDTH, aspect: PREVIEW_ASPECT },
  });
});

// ── GET /api/catalog/:id ─────────────────────────────
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * `?version=<sha256>`: the same projection with the archive of one of the scenario's versions,
 * for a draft preview. Never cached, whatever the answer. A public scenario's versions are
 * public; any other status needs the scenario's owner or a moderator (the viewer sends the
 * session's bearer), and everyone else gets the same 404 as for an unknown id or hash, so the
 * route confirms nothing about a scenario or version they may not see.
 */
async function versionPreview(req, res, sha256) {
  res.set('Cache-Control', 'no-store');

  const { rows: [scenario] } = await pool.query(
    `SELECT s.owner_key_id, (${PUBLIC_ROW}) AS "isPublic" ${ITEM_FROM} WHERE s.id = $1`, [req.params.id]
  );
  const visible = scenario
    && (scenario.isPublic || (req.principal && canEditScenario(req.principal, scenario)));
  const { rows: [version] } = visible
    ? await pool.query('SELECT sha256, bytes::float8 AS bytes FROM scenario_versions WHERE scenario_id = $1 AND sha256 = $2 LIMIT 1',
      [req.params.id, sha256])
    : { rows: [] };
  if (!version) return res.status(404).json({ error: 'Сценарій не знайдено' });

  const { rows: [item] } = await pool.query(`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE s.id = $1`, [req.params.id]);
  // A preview plays this archive as a ZIP, whatever the row's streaming manifest says.
  res.json({
    ...item,
    scenarioUrl: storage.publicUrl(version.sha256),
    manifestUrl: null,
    archiveBytes: version.bytes,
    related: [],
  });
}

router.get('/api/catalog/:id', optionalAuthenticate, async (req, res) => {
  try {
    if (req.query.version !== undefined) {
      const raw = req.query.version;
      if (typeof raw !== 'string' || !SHA256_HEX.test(raw.toLowerCase())) {
        res.set('Cache-Control', 'no-store');
        return res.status(400).json({ error: 'version має бути sha256 з 64 шістнадцяткових символів' });
      }
      return await versionPreview(req, res, raw.toLowerCase());
    }

    const { rows } = await pool.query(`
      SELECT ${ITEM_COLUMNS}
      ${ITEM_FROM}
      WHERE s.id = $1 AND ${PUBLIC_ROW}
    `, [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    // Same category first, then newest; never itself, never unpublished.
    const related = await pool.query(`
      SELECT
        s.id, s.title, s.category,
        COALESCE(c.label, s.category_label) AS "categoryLabel",
        s.image_url                         AS "imageUrl"
      ${ITEM_FROM}
      WHERE ${PUBLIC_ROW} AND s.id <> $1
      ORDER BY (s.category = $2) DESC, s.created_at DESC, s.id DESC
      LIMIT ${RELATED_LIMIT}
    `, [rows[0].id, rows[0].category]);

    res.json({ ...rows[0], related: related.rows });
  } catch (err) {
    console.error('[API] GET /api/catalog/:id error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

module.exports = { router, parseLimit, parseOffset, escapeLikePattern, parseSort };
