// backend/auth.js
//
// Who may write to the catalog.
//
// A request is authenticated by `Authorization: Bearer <token>`, which is one of
//   - a personal publish key (`publish_keys`, looked up by the SHA-256 of the
//     token) carrying the role `author` or `moderator`; or
//   - the bootstrap `ADMIN_TOKEN`, which acts as a moderator with no key row.
// `authenticate` turns it into `req.principal = { role, keyId, label }`;
// `requireRole` and `canEditScenario` decide what that principal may do.

const crypto = require('node:crypto');

const { pool } = require('./db');
const { failedAuth } = require('./rate-limits');

/** No real token comes near this; a longer one is wrong without hashing it. */
const MAX_TOKEN_LENGTH = 512;

/** Role -> rank; a role may do everything a lower rank may. */
const ROLE_RANK = { author: 1, moderator: 2 };

const BOOTSTRAP_LABEL = 'bootstrap';

/** Read per request, so an unset token turns the bootstrap off without a restart in tests. */
const bootstrapToken = () => process.env.ADMIN_TOKEN || '';

const sha256Hex = token => crypto.createHash('sha256').update(token).digest('hex');

function tokensMatch(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths separately.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The principal a token stands for, or null when it is unknown or revoked. */
async function resolvePrincipal(token) {
  if (token.length > MAX_TOKEN_LENGTH) return null;

  const bootstrap = bootstrapToken();
  if (bootstrap && tokensMatch(token, bootstrap)) {
    return { role: 'moderator', keyId: null, label: BOOTSTRAP_LABEL };
  }

  const { rows } = await pool.query(
    'SELECT id, label, role, revoked_at FROM publish_keys WHERE token_hash = $1',
    [sha256Hex(token)]
  );
  const key = rows[0];
  if (!key || key.revoked_at) return null;

  await pool.query('UPDATE publish_keys SET last_used_at = NOW() WHERE id = $1', [key.id]);
  return { role: key.role, keyId: key.id, label: key.label };
}

/**
 * Sets `req.principal` or answers: 401 when no credential was presented, 403
 * when it is unknown or revoked, 429 once an address has failed too often.
 * Only a presented-and-wrong credential counts against the address, and a valid
 * one is checked first, so a valid key is never limited.
 */
async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'Потрібна авторизація' });
  }

  try {
    const principal = await resolvePrincipal(token);
    if (principal) {
      req.principal = principal;
      return next();
    }
  } catch (err) {
    console.error('[AUTH] lookup error:', err.message);
    return res.status(500).json({ error: 'Помилка сервера' });
  }

  if (!failedAuth.consume(req.ip)) {
    res.set('Retry-After', String(failedAuth.retryAfterSeconds(req.ip)));
    return res.status(429).json({ error: 'Забагато невдалих спроб входу: спробуйте пізніше' });
  }
  res.status(403).json({ error: 'Невірний токен' });
}

/** Passes principals of `role` or higher (a moderator may do what an author may). */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.principal) return res.status(401).json({ error: 'Потрібна авторизація' });
    if (ROLE_RANK[req.principal.role] < ROLE_RANK[role]) {
      return res.status(403).json({ error: 'Недостатньо прав' });
    }
    next();
  };
}

/** `authenticate` then `requireRole(role)`, as one argument to a route. */
const authorize = role => [authenticate, requireRole(role)];

/** Moderators edit any scenario; an author edits only the ones their key owns. */
function canEditScenario(principal, row) {
  return principal.role === 'moderator'
    || (principal.keyId != null && row.owner_key_id === principal.keyId);
}

module.exports = {
  bootstrapToken,
  tokensMatch,
  sha256Hex,
  authenticate,
  requireRole,
  authorize,
  canEditScenario,
};
