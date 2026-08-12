// backend/server.js

const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { Pool } = require('pg');

const { runMigrations } = require('./migrations');
const storage = require('./storage');
const { validateScenarioArchive } = require('./archive-validation');

const app = express();

// Everything reaches the API same-origin through nginx, so CORS stays off
// unless an origin is named explicitly. A wildcard would expose the admin
// write endpoints to any page on the internet.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN }));
}

app.use(express.json());

// nginx sits in front and sets X-Forwarded-For; without this the rate limiter
// would bucket every client under the proxy's address.
app.set('trust proxy', 1);

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
 * Преобразует Google Drive sharing URL в прямую ссылку на скачивание.
 *
 * Вход:  https://drive.google.com/file/d/FILE_ID/view?usp=sharing
 * Выход: https://drive.google.com/uc?export=download&id=FILE_ID
 *
 * Также поддерживает формат:
 *   https://drive.google.com/open?id=FILE_ID
 */
function toGoogleDriveDirectUrl(url) {
  // Формат: /file/d/FILE_ID/...
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) {
    return `https://drive.google.com/uc?export=download&id=${fileMatch[1]}`;
  }

  // Формат: ?id=FILE_ID
  const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) {
    return `https://drive.google.com/uc?export=download&id=${idMatch[1]}`;
  }

  // Не Google Drive — вернуть как есть
  return url;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeEscapedUrl(value) {
  return decodeHtmlEntities(value)
    .replace(/\\u003d/g, '=')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/');
}

function extractDriveConfirmUrl(html, baseUrl) {
  const formMatch = html.match(/<form[^>]*id=["']download-form["'][^>]*action=["']([^"']+)["'][^>]*>/i);
  if (formMatch?.[1]) {
    try {
      const actionUrl = new URL(normalizeEscapedUrl(formMatch[1]), baseUrl);
      const inputPattern = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
      let inputMatch;

      while ((inputMatch = inputPattern.exec(html)) !== null) {
        const key = inputMatch[1];
        const value = decodeHtmlEntities(inputMatch[2]);
        actionUrl.searchParams.set(key, value);
      }

      if (actionUrl.searchParams.has('confirm')) {
        return actionUrl.toString();
      }
    } catch {
      // Fall through to pattern-based extraction.
    }
  }

  const patterns = [
    /href=["']([^"']*confirm[^"']*)["']/i,
    /action=["']([^"']*\/uc\?[^"']*)["']/i,
    /"(https?:\\\/\\\/[^"\\]*(?:confirm|export\\u003ddownload)[^"\\]*)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match?.[1]) continue;

    try {
      const candidate = normalizeEscapedUrl(match[1]);
      return new URL(candidate, baseUrl).toString();
    } catch {
      // Try next pattern.
    }
  }

  return null;
}

function extractDriveConfirmToken(html) {
  const patterns = [
    /[?&]confirm=([a-zA-Z0-9_-]+)/i,
    /name=["']confirm["']\s+value=["']([^"']+)["']/i,
    /"confirm"\s*:\s*"([^"]+)"/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function buildConfirmedUrl(directUrl, token) {
  const url = new URL(directUrl);
  url.searchParams.set('confirm', token);
  return url.toString();
}

// ══════════════════════════════════════════════════════
// PROXY INTERNALS
// ══════════════════════════════════════════════════════

const ALLOWED_PROXY_HOSTS = [
  'drive.google.com',
  'docs.google.com',
  // Drive redirects every actual download here. The old code used
  // redirect: 'follow', so this hop was never checked and the allowlist did
  // nothing on a real request; with per-hop validation it has to be listed.
  'drive.usercontent.google.com',
  'storage.googleapis.com',
];

/**
 * The Drive proxy is legacy: it scrapes Google's HTML confirmation page.
 * It stays available for one release while scenarios are imported into local
 * storage, then this can be set to false and the Drive code deleted.
 */
const LEGACY_DRIVE_PROXY = process.env.LEGACY_DRIVE_PROXY !== 'false';

const MAX_REDIRECTS = 5;
/** Applies to response headers only — the body may legitimately stream for minutes. */
const HEADERS_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_BYTES = Number(process.env.MAX_ARCHIVE_BYTES || 2 * 1024 * 1024 * 1024);

const BINARY_CONTENT_TYPES = [
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
  'binary/octet-stream',
];

class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function assertAllowedHost(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new ProxyError(400, 'Невалідний URL');
  }

  if (!ALLOWED_PROXY_HOSTS.includes(hostname)) {
    throw new ProxyError(403, `Домен "${hostname}" не дозволено`);
  }
}

/**
 * Fetches `url`, following redirects **manually** so the allowlist is re-checked
 * on every hop. `redirect: 'follow'` would let an allowlisted host bounce the
 * request anywhere.
 *
 * The timeout covers the response headers, not the body: aborting a multi-minute
 * archive download mid-stream would be worse than no timeout at all.
 */
async function fetchAllowlisted(url) {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedHost(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'VirtualLab-Proxy/1.0' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});

      if (!location) {
        throw new ProxyError(502, 'Редірект без заголовка Location');
      }
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      throw new ProxyError(502, `Джерело повернуло помилку: ${response.status}`);
    }

    return { response, url: current };
  }

  throw new ProxyError(502, 'Забагато редіректів');
}

/** Fails the stream once the response exceeds the cap, instead of relaying it whole. */
function createSizeLimiter(maxBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new ProxyError(502, `Архів перевищує ліміт ${maxBytes} байт`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/**
 * Resolves an external archive link to a live response carrying the ZIP.
 *
 * Handles Drive's sharing-link conversion and its large-file confirmation page,
 * and refuses anything whose final content type is not an archive. Shared by the
 * download proxy and by the "import into local storage" endpoint so the two can
 * never drift apart.
 */
async function fetchArchiveFromDrive(sourceUrl) {
  const directUrl = toGoogleDriveDirectUrl(sourceUrl);
  const first = await fetchAllowlisted(directUrl);
  let upstream = first.response;

  // Для больших файлов Google показывает страницу подтверждения.
  const contentType = upstream.headers.get('content-type') || '';

  if (contentType.includes('text/html')) {
    const html = await upstream.text();
    const confirmUrlFromHtml = extractDriveConfirmUrl(html, first.url);
    const confirmToken = extractDriveConfirmToken(html);
    const confirmUrl = confirmUrlFromHtml
      || (confirmToken ? buildConfirmedUrl(directUrl, confirmToken) : null);

    if (!confirmUrl) {
      throw new ProxyError(403, 'Файл на Google Drive не є публічним або потребує авторизації');
    }

    console.log(`[PROXY] Large file confirmation via ${confirmUrlFromHtml ? 'url' : 'token'}`);
    upstream = (await fetchAllowlisted(confirmUrl)).response;
  }

  // Whatever we relay must be an archive — never HTML, never a login page.
  const finalType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (finalType && !BINARY_CONTENT_TYPES.includes(finalType)) {
    await upstream.body?.cancel().catch(() => {});
    throw new ProxyError(502, `Неочікуваний тип вмісту: ${finalType}`);
  }

  return upstream;
}

async function streamUpstreamToClient(res, upstream, fallbackContentType = 'application/octet-stream') {
  const contentType = upstream.headers.get('content-type') || fallbackContentType;
  const declaredLength = Number(upstream.headers.get('content-length') || 0);

  if (declaredLength > MAX_ARCHIVE_BYTES) {
    throw new ProxyError(502, `Архів перевищує ліміт ${MAX_ARCHIVE_BYTES} байт`);
  }

  res.setHeader('Content-Type', contentType);
  if (declaredLength) res.setHeader('Content-Length', String(declaredLength));

  if (!upstream.body) {
    res.end();
    return;
  }

  // pipeline (not a manual read/write loop) so backpressure is respected —
  // otherwise a slow client makes the server buffer the whole archive in memory.
  await pipeline(
    Readable.fromWeb(upstream.body),
    createSizeLimiter(MAX_ARCHIVE_BYTES),
    res
  );
}

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

app.get('/api/catalog', async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const category = req.query.category && req.query.category !== 'all' ? String(req.query.category) : null;
  const query = req.query.q ? String(req.query.q).trim() : '';
  const pattern = query ? `%${escapeLikePattern(query)}%` : null;

  // Filtering runs here rather than in the browser: with pagination, a
  // client-side filter would only ever search the page it happens to hold.
  const where = `
    WHERE is_published = true
      AND ($1::text IS NULL OR category = $1)
      AND (
        $2::text IS NULL
        OR title       ILIKE $2 ESCAPE '\'
        OR description ILIKE $2 ESCAPE '\'
      )
  `;

  try {
    // Categories describe the whole published catalog, not the filtered page —
    // otherwise chips would vanish as soon as one was selected.
    const [scenarios, total, categories] = await Promise.all([
      pool.query(`
        SELECT
          id,
          title,
          description,
          full_description   AS "fullDescription",
          category,
          category_label     AS "categoryLabel",
          image_url          AS "imageUrl",
          scenario_url       AS "scenarioUrl",
          version,
          author,
          upload_date        AS "uploadDate"
        FROM scenarios
        ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $3 OFFSET $4
      `, [category, pattern, limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS count FROM scenarios ${where}`, [category, pattern]),
      pool.query(`
        SELECT DISTINCT
          category,
          category_label AS "categoryLabel"
        FROM scenarios
        WHERE is_published = true
        ORDER BY category_label
      `),
    ]);

    res.json({
      version: '1',
      scenarios: scenarios.rows,
      categories: categories.rows,
      total: total.rows[0].count,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[API] GET /api/catalog error:', err.message);
    res.status(500).json({ error: 'Не вдалося завантажити каталог' });
  }
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
        version, author,
        upload_date        AS "uploadDate",
        is_published       AS "isPublished",
        storage_kind       AS "storageKind",
        archive_sha256     AS "archiveSha256",
        archive_bytes      AS "archiveBytes",
        manifest_id        AS "manifestId",
        manifest_version   AS "manifestVersion",
        manifest_engine_version AS "manifestEngineVersion",
        updated_at         AS "updatedAt"
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
      SELECT
        id, title, description,
        full_description   AS "fullDescription",
        category, category_label AS "categoryLabel",
        image_url AS "imageUrl", scenario_url AS "scenarioUrl",
        version, author, upload_date AS "uploadDate"
      FROM scenarios
      WHERE id = $1 AND is_published = true
    `, [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[API] GET /api/catalog/:id error:', err.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ── POST /api/catalog ────────────────────────────────
app.post('/api/catalog', requireAdmin, async (req, res) => {
  const {
    id, title, description, fullDescription,
    category, categoryLabel, imageUrl, scenarioUrl,
    version, author,
  } = req.body;

  if (!id || !title || !category || !categoryLabel) {
    return res.status(400).json({
      error: 'Обов\'язкові поля: id, title, category, categoryLabel',
    });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO scenarios
      (id, title, description, full_description, category, category_label,
       image_url, scenario_url, version, author)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id
    `, [
      id, title,
      description || '', fullDescription || '',
      category, categoryLabel,
      imageUrl || '', scenarioUrl || '',
      version || '1.0.0', author || null,
    ]);

    res.status(201).json({ id: rows[0].id, message: 'Сценарій додано' });
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
    category, categoryLabel, imageUrl, scenarioUrl,
    version, author, isPublished,
  } = req.body;

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
  addField('version', version);
  addField('author', author);
  addField('is_published', isPublished);

  if (fields.length === 0) {
    return res.status(400).json({ error: 'Не вказано жодного поля для оновлення' });
  }

  // Автоматически обновляем updated_at
  fields.push(`updated_at = NOW()`);

  try {
    values.push(id); // последний параметр — WHERE id = $N
    const { rowCount } = await pool.query(
      `UPDATE scenarios SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

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
// PROXY — скачивание ZIP с Google Drive (обход CORS)
// ══════════════════════════════════════════════════════

const proxyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PROXY_RATE_LIMIT || 60),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Забагато запитів на завантаження. Спробуйте пізніше.' },
});

/**
 * GET /api/proxy-download?id=<scenario id>
 *
 * Фронтенд не может скачать файл с Google Drive напрямую из-за CORS.
 *
 * The archive URL is looked up in `scenarios` — it is never taken from the
 * request. Accepting a client-supplied URL turned this endpoint into an open
 * relay for any object on the allowlisted hosts.
 */
app.get('/api/proxy-download', proxyLimiter, async (req, res) => {
  if (!LEGACY_DRIVE_PROXY) {
    return res.status(410).json({
      error: 'Проксі вимкнено. Усі архіви обслуговуються з локального сховища.',
    });
  }

  const { id } = req.query;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Параметр "id" обов\'язковий' });
  }

  let originalUrl;
  try {
    const { rows } = await pool.query(
      'SELECT scenario_url FROM scenarios WHERE id = $1 AND is_published = true',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    originalUrl = rows[0].scenario_url;
    if (!originalUrl) {
      return res.status(404).json({ error: 'Для цього сценарію не вказано архів' });
    }
  } catch (err) {
    console.error('[PROXY] Lookup error:', err.message);
    return res.status(500).json({ error: 'Помилка сервера' });
  }

  console.log(`[PROXY] ${id} → ${originalUrl}`);

  try {
    const upstream = await fetchArchiveFromDrive(originalUrl);
    await streamUpstreamToClient(res, upstream, 'application/zip');

  } catch (err) {
    const status = err instanceof ProxyError ? err.status : 502;
    console.error(`[PROXY] ${err.message}`);

    if (res.headersSent) {
      // Already streaming — the only honest signal left is an abrupt end.
      res.destroy(err);
      return;
    }
    res.status(status).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// ARCHIVES — content-addressed storage
// ══════════════════════════════════════════════════════

const upload = multer({
  dest: storage.TMP_DIR,
  limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1 },
});

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
 * POST /api/scenarios/:id/archive   (admin, multipart field "archive")
 *
 * Stores the upload as /scenarios/<sha256>.zip and repoints the scenario at it.
 * Identical content uploaded twice reuses the same object.
 */
app.post('/api/scenarios/:id/archive', requireAdmin, upload.single('archive'), async (req, res) => {
  const { id } = req.params;
  const tmpFile = req.file?.path;

  // commitArchive either renames the temp file into the store or deletes it;
  // every other exit path — including the early 404 — must clean up itself.
  let consumed = false;

  try {
    if (!tmpFile) {
      return res.status(400).json({ error: 'Очікується файл у полі "archive"' });
    }

    if (!(await scenarioExists(id))) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    // Validate before committing — a broken archive must never enter the store.
    const { manifest, warnings } = await validateScenarioArchive(tmpFile, id);

    const result = await storage.commitArchive(tmpFile);
    consumed = true;
    await attachArchive(id, result, manifest);

    console.log(`[ARCHIVE] ${id} → ${result.url} (${result.bytes} bytes${result.deduplicated ? ', dedup' : ''})`);
    res.status(201).json({ id, ...result, manifestId: manifest.id, warnings });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[ARCHIVE] Upload error:', err.message);
    res.status(status).json({ error: err.message });
  } finally {
    if (!consumed) await storage.discardTemp(tmpFile);
  }
});

/**
 * POST /api/scenarios/:id/archive/import   (admin)
 *
 * Pulls the scenario's current external archive into local storage. This is the
 * migration path off Google Drive: it reuses the proxy's allowlist, redirect
 * checks and confirm-page handling, so nothing new is exposed.
 */
app.post('/api/scenarios/:id/archive/import', requireAdmin, async (req, res) => {
  const { id } = req.params;
  let tmpFile;
  let consumed = false;

  try {
    const { rows } = await pool.query(
      'SELECT scenario_url, storage_kind FROM scenarios WHERE id = $1',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    const { scenario_url: sourceUrl, storage_kind: storageKind } = rows[0];

    if (storageKind === 'local') {
      return res.status(409).json({ error: 'Архів вже у локальному сховищі' });
    }
    if (!sourceUrl) {
      return res.status(400).json({ error: 'Для цього сценарію не вказано посилання' });
    }

    const upstream = await fetchArchiveFromDrive(sourceUrl);
    tmpFile = await storage.writeTempFromStream(Readable.fromWeb(upstream.body));

    const { manifest, warnings } = await validateScenarioArchive(tmpFile, id);

    const result = await storage.commitArchive(tmpFile);
    consumed = true;
    await attachArchive(id, result, manifest);

    console.log(`[ARCHIVE] imported ${id} → ${result.url} (${result.bytes} bytes)`);
    res.status(201).json({ id, source: sourceUrl, ...result, manifestId: manifest.id, warnings });
  } catch (err) {
    const status = err.status || 502;
    console.error(`[ARCHIVE] Import failed for ${id}: ${err.message}`);
    res.status(status).json({ error: err.message });
  } finally {
    if (!consumed) await storage.discardTemp(tmpFile);
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
  toGoogleDriveDirectUrl,
  parseLimit,
  parseOffset,
};
