// backend/auth.js
//
// Who may write to the catalog.

const crypto = require('node:crypto');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

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

module.exports = { ADMIN_TOKEN, tokensMatch, requireAdmin };
