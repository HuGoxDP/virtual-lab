// backend/server.js

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ── Подключение к PostgreSQL ─────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || 'virtual_lab',
  user:     process.env.DB_USER     || 'lab_user',
  password: process.env.DB_PASSWORD || 'lab_secret_123',
});

pool.query('SELECT NOW()')
  .then(() => console.log('[DB] Connected to PostgreSQL'))
  .catch(err => console.error('[DB] Connection failed:', err.message));

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

async function streamUpstreamToClient(res, upstream, fallbackContentType = 'application/octet-stream') {
  const contentType = upstream.headers.get('content-type') || fallbackContentType;
  res.setHeader('Content-Type', contentType);

  const cl = upstream.headers.get('content-length');
  if (cl) res.setHeader('Content-Length', cl);

  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      res.end();
      return;
    }
    res.write(Buffer.from(value));
  }
}

// ══════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════

// ── GET /api/catalog ─────────────────────────────────
app.get('/api/catalog', async (req, res) => {
  try {
    const { rows } = await pool.query(`
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
      WHERE is_published = true
      ORDER BY created_at DESC
    `);

    res.json({
      version: '1',
      scenarios: rows,
    });
  } catch (err) {
    console.error('[API] GET /api/catalog error:', err.message);
    res.status(500).json({ error: 'Не вдалося завантажити каталог' });
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
app.post('/api/catalog', async (req, res) => {
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
app.put('/api/catalog/:id', async (req, res) => {
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
app.delete('/api/catalog/:id', async (req, res) => {
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

/**
 * GET /api/proxy-download?url=https://drive.google.com/file/d/.../view
 *
 * Фронтенд не может скачать файл с Google Drive напрямую
 * из-за CORS-ограничений. Этот endpoint:
 * 1. Принимает Google Drive sharing URL
 * 2. Преобразует в прямую ссылку на скачивание
 * 3. Скачивает файл на сервере
 * 4. Отдаёт клиенту как stream (с прогрессом)
 */
app.get('/api/proxy-download', async (req, res) => {
  const originalUrl = req.query.url;

  if (!originalUrl) {
    return res.status(400).json({ error: 'Параметр "url" обов\'язковий' });
  }

  // Безопасность: разрешаем только определённые домены
  const allowedDomains = [
    'drive.google.com',
    'docs.google.com',
    'storage.googleapis.com',
  ];

  try {
    const parsedUrl = new URL(originalUrl);
    if (!allowedDomains.includes(parsedUrl.hostname)) {
      return res.status(403).json({
        error: `Домен "${parsedUrl.hostname}" не дозволено. Дозволені: ${allowedDomains.join(', ')}`,
      });
    }
  } catch {
    return res.status(400).json({ error: 'Невалідний URL' });
  }

  // Преобразуем Google Drive sharing link → direct download
  const directUrl = toGoogleDriveDirectUrl(originalUrl);
  console.log(`[PROXY] ${originalUrl} → ${directUrl}`);

  try {
    // Fetch с поддержкой редиректов (Google Drive делает несколько)
    const upstream = await fetch(directUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'VirtualLab-Proxy/1.0',
      },
    });

    if (!upstream.ok) {
      console.error(`[PROXY] Upstream returned ${upstream.status}`);
      return res.status(502).json({
        error: `Google Drive повернув помилку: ${upstream.status}`,
      });
    }

    // Для больших файлов Google показывает страницу подтверждения.
    // Проверяем Content-Type — если HTML, значит нужно подтверждение.
    const contentType = upstream.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      // Большой файл — Google требует подтверждения.
      // Извлекаем confirm-токен и повторяем запрос.
      const html = await upstream.text();
      const confirmUrlFromHtml = extractDriveConfirmUrl(html, directUrl);
      const confirmToken = extractDriveConfirmToken(html);
      const confirmUrl = confirmUrlFromHtml || (confirmToken ? buildConfirmedUrl(directUrl, confirmToken) : null);

      if (confirmUrl) {
        console.log(`[PROXY] Large file confirmation via ${confirmUrlFromHtml ? 'url' : 'token'}: ${confirmUrl}`);

        const confirmed = await fetch(confirmUrl, {
          redirect: 'follow',
          headers: { 'User-Agent': 'VirtualLab-Proxy/1.0' },
        });

        if (!confirmed.ok) {
          console.error(`[PROXY] Confirmed fetch returned ${confirmed.status}`);
          return res.status(502).json({ error: 'Не вдалося завантажити великий файл' });
        }

        return streamUpstreamToClient(res, confirmed, 'application/zip').catch(err => {
          console.error('[PROXY] Stream error:', err.message);
          if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
        });
      }

      // Не нашли confirm-токен — возможно файл не публичный
      console.error('[PROXY] Google Drive warning page did not contain confirm token/url');
      return res.status(403).json({
        error: 'Файл на Google Drive не є публічним або потребує авторизації',
      });
    }

    // Обычный файл — стримим напрямую
    return streamUpstreamToClient(res, upstream).catch(err => {
      console.error('[PROXY] Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
    });

  } catch (err) {
    console.error('[PROXY] Fetch error:', err.message);
    res.status(502).json({ error: `Помилка проксі: ${err.message}` });
  }
});

// ── Health check ─────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ── Start ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[API] Server running on port ${PORT}`);
});
