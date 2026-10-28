// backend/server.js

const crypto = require('node:crypto');

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { Pool } = require('pg');

const { runMigrations } = require('./migrations');
const storage = require('./storage');
const { validateScenarioArchive } = require('./archive-validation');
const { validateFeatures } = require('./catalog-input');
const { createLtiRouter } = require('./lti');
const { parseTrustProxy } = require('./trust-proxy');

const app = express();

// Everything reaches the API same-origin through nginx, so CORS stays off
// unless an origin is named explicitly. A wildcard would expose the admin
// write endpoints to any page on the internet.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN }));
}

app.use(express.json());

// nginx sits in front and sets X-Forwarded-For; without this the rate limiters
// would bucket every client under the proxy's address. TRUST_PROXY names how many
// proxies really are in front (default 1): trusting more lets a client choose its own address.
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy.warning) console.warn(`[API] ${trustProxy.warning}`);
app.set('trust proxy', trustProxy.value);

// ── Подключение к PostgreSQL ─────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'virtual_lab',
  user:     process.env.DB_USER     || 'lab_user',
  password: process.env.DB_PASSWORD,
});

// An idle client can emit 'error' (database restart, dropped connection).
// Without a listener that is an unhandled error event and takes the process
// down; pg discards the broken client on its own.
pool.on('error', err => {
  console.error('[DB] Idle client error:', err.message);
});


// ══════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!ADMIN_TOKEN && require.main === module) {
  console.warn('[AUTH] ADMIN_TOKEN is not set — catalog writes are disabled');
}

function tokensMatch(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths separately.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Guards catalog mutation. Reads only: public. Writes: `Authorization: Bearer <ADMIN_TOKEN>`.
 */
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Адміністративний доступ не налаштовано' });
  }

  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Потрібна авторизація' });
  }

  if (!tokensMatch(header.slice(7), ADMIN_TOKEN)) {
    return res.status(403).json({ error: 'Невірний токен' });
  }

  next();
}

// ══════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════


/**
 * Largest archive accepted on upload.
 *
 * Everything else that used to live in this section — Google Drive URL
 * rewriting, confirmation-page scraping, a host allowlist and a redirect-
 * following fetcher — is gone: every catalog row is served from local storage
 * now, so none of it had a caller.
 */
const DEFAULT_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/** Read once at load; a junk value falls back to the default rather than disabling the cap. */
function parseMaxArchiveBytes(raw) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_ARCHIVE_BYTES;
}

const MAX_ARCHIVE_BYTES = parseMaxArchiveBytes(process.env.MAX_ARCHIVE_BYTES);

// ══════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════

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

/** Whitelisted ORDER BY fragments: user input only selects a key, it never reaches the SQL text. */
const CATALOG_SORTS = {
  new:   's.created_at DESC, s.id DESC',
  title: 's.title COLLATE "uk-x-icu", s.id',
};

/** Unknown, empty or repeated (`sort[]=a&sort[]=b`) values fall back to newest first. */
function parseSort(raw) {
  return typeof raw === 'string' && Object.hasOwn(CATALOG_SORTS, raw) ? raw : 'new';
}

app.get('/api/catalog', async (req, res) => {
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
    WHERE s.is_published = true
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
        JOIN scenarios s ON s.category = c.slug AND s.is_published = true
        WHERE c.is_visible = true
        GROUP BY c.slug, c.label, c.icon, c.sort_order
        ORDER BY c.sort_order, c.slug
      `),
      pool.query('SELECT COUNT(*)::int AS count FROM scenarios WHERE is_published = true'),
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
app.get('/api/config', (req, res) => {
  res.json({ maxArchiveBytes: MAX_ARCHIVE_BYTES });
});

// ── GET /api/admin/scenarios ─────────────────────────
// Everything the catalog hides: unpublished rows, storage state, archive
// metadata. `is_published` was previously only reachable through raw SQL.
app.get('/api/admin/scenarios', requireAdmin, async (req, res) => {
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

// ── GET /api/catalog/:id ─────────────────────────────
app.get('/api/catalog/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ${ITEM_COLUMNS}
      ${ITEM_FROM}
      WHERE s.id = $1 AND s.is_published = true
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
      WHERE s.is_published = true AND s.id <> $1
      ORDER BY (s.category = $2) DESC, s.created_at DESC, s.id DESC
      LIMIT ${RELATED_LIMIT}
    `, [rows[0].id, rows[0].category]);

    res.json({ ...rows[0], related: related.rows });
  } catch (err) {
    console.error('[API] GET /api/catalog/:id error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

/** Runs `work(client)` in a transaction; rolls back and rethrows on any failure. */
async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

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
app.post('/api/catalog', requireAdmin, async (req, res) => {
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
app.put('/api/catalog/:id', requireAdmin, async (req, res) => {
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
app.delete('/api/catalog/:id', requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM scenarios WHERE id = $1',
      [req.params.id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    res.json({ message: 'Сценарій видалено' });
  } catch (err) {
    console.error('[API] DELETE error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ══════════════════════════════════════════════════════
// ARCHIVES — content-addressed storage
// ══════════════════════════════════════════════════════

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

async function scenarioExists(id) {
  const { rowCount } = await pool.query('SELECT 1 FROM scenarios WHERE id = $1', [id]);
  return rowCount > 0;
}

/** Points a scenario at a stored object and records its integrity metadata. */
async function attachArchive(id, { sha256, bytes, url }, manifest) {
  await pool.query(`
    UPDATE scenarios
       SET scenario_url            = $1,
           archive_sha256          = $2,
           archive_bytes           = $3,
           manifest_id             = $4,
           manifest_version        = $5,
           manifest_engine_version = $6,
           graded                  = $7,
           storage_kind            = 'local',
           updated_at              = NOW()
     WHERE id = $8
  `, [
    url, sha256, bytes,
    manifest?.id ?? null,
    manifest?.version ?? null,
    // Which engine build the scenario was compiled against — null for archives
    // predating ScenarioCreator stamping it.
    manifest?.engineVersion ?? null,
    // Only an explicit `graded: true` makes a scenario graded; re-uploading without the key clears it.
    manifest?.graded === true,
    id,
  ]);
}

/**
 * POST /api/scenarios/:id/archive   (admin, multipart field "archive")
 *
 * Stores the upload as /scenarios/<sha256>.zip and repoints the scenario at it.
 * Identical content uploaded twice reuses the same object.
 */
app.post('/api/scenarios/:id/archive', requireAdmin, receiveArchive, async (req, res) => {
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

    await attachArchive(id, result, manifest);
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


// ══════════════════════════════════════════════════════
// STORAGE — reporting and garbage collection
// ══════════════════════════════════════════════════════

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
app.get('/api/admin/storage', requireAdmin, async (req, res) => {
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
app.post('/api/admin/storage/gc', requireAdmin, async (req, res) => {
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

// ══════════════════════════════════════════════════════
// TELEMETRY — anonymous scenario sessions
// ══════════════════════════════════════════════════════

/** Anything longer is a tab left open overnight, not a session. */
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const telemetryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.TELEMETRY_RATE_LIMIT || 300),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Забагато запитів' },
});

/**
 * POST /api/telemetry/session   { scenarioId, clientId? }
 *
 * Records that a scenario started. Public and anonymous — `clientId` is a
 * random per-browser UUID, never tied to a person.
 */
app.post('/api/telemetry/session', telemetryLimiter, async (req, res) => {
  const scenarioId = typeof req.body?.scenarioId === 'string' ? req.body.scenarioId : '';
  const rawClientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
  const clientId = UUID_PATTERN.test(rawClientId) ? rawClientId : null;

  if (!scenarioId) {
    return res.status(400).json({ error: 'scenarioId обов\'язковий' });
  }

  try {
    // Bound the data to real scenarios so the table cannot be filled with junk.
    if (!(await scenarioExists(scenarioId))) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    const userAgent = (req.get('user-agent') || '').slice(0, 300);

    const { rows } = await pool.query(`
      INSERT INTO scenario_sessions (scenario_id, client_id, user_agent)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [scenarioId, clientId, userAgent]);

    res.status(201).json({ sessionId: String(rows[0].id) });
  } catch (err) {
    console.error('[TELEMETRY] start error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

/**
 * POST /api/telemetry/session/:id/end
 *
 * Closes a session. POST rather than PATCH so the browser can send it with
 * `navigator.sendBeacon` during unload, which is the only reliable moment.
 *
 * Idempotent by construction: the UPDATE only matches a session that is still
 * open, so a replay cannot inflate anything. Duration is computed server-side
 * from `started_at` and clamped — it is never taken from the client.
 */
app.post('/api/telemetry/session/:id/end', telemetryLimiter, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Невалідний id сесії' });
  }

  try {
    await pool.query(`
      UPDATE scenario_sessions
         SET ended_at    = NOW(),
             duration_ms = LEAST(
               GREATEST(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000, 0),
               $2
             )::int
       WHERE id = $1
         AND ended_at IS NULL
    `, [id, MAX_SESSION_MS]);

    // 204 regardless: sendBeacon ignores the response, and telling a caller
    // whether a session id exists would leak nothing useful anyway.
    res.status(204).end();
  } catch (err) {
    console.error('[TELEMETRY] end error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

/**
 * GET /api/telemetry/summary?days=30   (admin)
 *
 * Launches and median duration per scenario. Median rather than mean: one tab
 * left open for hours would otherwise dominate the average.
 */
app.get('/api/telemetry/summary', requireAdmin, async (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), 365);

  try {
    const { rows } = await pool.query(`
      SELECT
        s.scenario_id                                   AS "scenarioId",
        c.title                                         AS "title",
        COUNT(*)::int                                   AS "launches",
        COUNT(s.ended_at)::int                          AS "completed",
        COUNT(DISTINCT s.client_id)::int                AS "uniqueClients",
        COALESCE(
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.duration_ms), 0
        )::int                                          AS "medianDurationMs",
        MAX(s.started_at)                               AS "lastStartedAt"
      FROM scenario_sessions s
      LEFT JOIN scenarios c ON c.id = s.scenario_id
      WHERE s.started_at >= NOW() - ($1 || ' days')::interval
      GROUP BY s.scenario_id, c.title
      ORDER BY "launches" DESC
    `, [String(days)]);

    res.json({ days, scenarios: rows });
  } catch (err) {
    console.error('[TELEMETRY] summary error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── LTI 1.3 tool (Moodle and other LMS platforms) ────
// Its own module and router; answers 503 until LTI_PUBLIC_URL is set, and touches nothing else here.
app.use('/api/lti', createLtiRouter({ pool, env: process.env }));

// ── Health check ─────────────────────────────────────

/**
 * Identity of *this* build — the API's, not the engine's.
 *
 * The split is deliberate. The engine build is a property of the bundle running
 * in the browser, and the browser is the only place that can read it
 * (`BuildInfo`, shown in the viewer under `?diag=1`). Reporting it from here
 * would mean the backend restating something it cannot observe, and the two
 * would drift the moment a new tarball was installed without a backend rebuild.
 *
 * `commit` is null unless the image was built with API_COMMIT set. Null is the
 * honest answer for "built from a working tree" — better than a stale default.
 */
const API_BUILD = {
  version: require('./package.json').version,
  commit: process.env.API_COMMIT || null,
  startedAt: new Date().toISOString(),
};

app.get('/api/health', async (req, res) => {
  const build = { ...API_BUILD, uptimeSeconds: Math.round(process.uptime()) };

  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', build });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected', build });
  }
});

// ── Start ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Migrations and storage directories must exist before the first request:
// a half-migrated schema serving traffic is worse than a restart loop.
async function bootstrap() {
  await pool.query('SELECT NOW()')
    .then(() => console.log('[DB] Connected to PostgreSQL'))
    .catch(err => console.error('[DB] Connection failed:', err.message));

  await storage.ensureStorageDirs();
  await runMigrations(pool);
  await storage.cleanStaleTemp();

  return app.listen(PORT, () => {
    console.log(`[API] Server running on port ${PORT}`);
  });
}

let server;

// Only bind a port when run as the entry point. Under test, `app` and `pool`
// are imported directly so supertest can drive the routes without a listener.
if (require.main === module) {
  bootstrap()
    .then(instance => { server = instance; })
    .catch(err => {
      console.error('[API] Startup failed:', err.message);
      process.exit(1);
    });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ── Graceful shutdown ────────────────────────────────
// `docker compose down` sends SIGTERM; without this the process is killed
// outright and in-flight archive streams are cut mid-transfer.
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[API] ${signal} received, shutting down`);

  const force = setTimeout(() => {
    console.error('[API] Forced exit after timeout');
    process.exit(1);
  }, 10_000);
  force.unref();

  if (!server) {
    // Signalled while still bootstrapping.
    pool.end().catch(() => {}).finally(() => process.exit(0));
    return;
  }

  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      console.error('[DB] Pool shutdown error:', err.message);
    }
    clearTimeout(force);
    process.exit(0);
  });
}

module.exports = {
  app,
  pool,
  bootstrap,
  // Exported for unit tests — pure helpers with no HTTP surface of their own.
  escapeLikePattern,
  tokensMatch,
  parseLimit,
  parseOffset,
  parseSort,
  parseMaxArchiveBytes,
};
