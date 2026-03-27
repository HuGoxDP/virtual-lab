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
      const confirmMatch = html.match(/confirm=([a-zA-Z0-9_-]+)/);

      if (confirmMatch) {
        const confirmUrl = `${directUrl}&confirm=${confirmMatch[1]}`;
        console.log(`[PROXY] Large file, confirming: ${confirmUrl}`);

        const confirmed = await fetch(confirmUrl, {
          redirect: 'follow',
          headers: { 'User-Agent': 'VirtualLab-Proxy/1.0' },
        });

        if (!confirmed.ok) {
          return res.status(502).json({ error: 'Не вдалося завантажити великий файл' });
        }

        // Стримим подтверждённый ответ
        res.setHeader('Content-Type', 'application/zip');
        const cl = confirmed.headers.get('content-length');
        if (cl) res.setHeader('Content-Length', cl);

        const reader = confirmed.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            res.write(Buffer.from(value));
          }
        };
        return pump().catch(err => {
          console.error('[PROXY] Stream error:', err.message);
          if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
        });
      }

      // Не нашли confirm-токен — возможно файл не публичный
      return res.status(403).json({
        error: 'Файл на Google Drive не є публічним або потребує авторизації',
      });
    }

    // Обычный файл — стримим напрямую
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);

    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(Buffer.from(value));
      }
    };
    pump().catch(err => {
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
