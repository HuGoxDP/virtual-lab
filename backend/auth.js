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

/**
 * A personal key's prefix: recognisable in a log or a secret scan without
 * being a secret itself. Keys issued before B6 carry no prefix and keep
 * working (their SHA-256 is what is stored, whatever the token looked like).
 */
const KEY_PREFIX = 'vlk_';

/** The shortest ADMIN_TOKEN accepted without a start-up warning. */
const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;

/**
 * A fresh personal key: 256 bits of randomness in the URL alphabet, so it is
 * safe to paste anywhere a token may end up. The generated value is returned
 * once and stored only as its SHA-256 (routes/keys.js); nothing here keeps it.
 *
 * @returns {string} `vlk_` + 43 characters
 */
function generateToken() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** Role -> rank; a role may do everything a lower rank may. */
const ROLE_RANK = { author: 1, moderator: 2 };

const BOOTSTRAP_LABEL = 'bootstrap';

/** Read per request, so an unset token turns the bootstrap off without a restart in tests. */
const bootstrapToken = () => process.env.ADMIN_TOKEN || '';

/**
 * Whether a credential is accepted only over HTTPS (B6 phase 2).
 *
 * Read per request like the bootstrap token, so a test or an operator can turn it
 * on without a restart. Only the literal true/1 turns it on: anything else keeps
 * today's behaviour, because a typo must not lock the platform out.
 */
function httpsRequired() {
  const raw = process.env.REQUIRE_HTTPS;
  return raw === 'true' || raw === '1';
}

const sha256Hex = token => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Constant-time comparison of two tokens.
 *
 * Both sides are hashed first and only the fixed-width digests are compared:
 * `timingSafeEqual` throws on a length mismatch, and a length check before it
 * would leak the expected token's length to a timing oracle — which matters
 * for the bootstrap ADMIN_TOKEN, the one secret compared in place (a personal
 * key is found by a database lookup on its hash, so nothing about the token
 * is compared at all).
 */
function tokensMatch(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
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
  // B6 phase 2: with the switch on, a credential never travels in the clear. The
  // answer is 403 https_required before anything is resolved, and it does not count
  // against the address — 31 such calls still answer 403, never 429.
  if (httpsRequired() && !req.secure) {
    return res.status(403).json({ error: 'Потрібне HTTPS-з’єднання', code: 'https_required' });
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

/**
 * For a public route that shows more to its owner or a moderator: sets `req.principal`
 * when a valid credential is presented and otherwise carries on anonymously. A presented
 * credential that is wrong still counts against the address (this route would otherwise
 * be a free place to guess tokens) and answers 429 once the address is over the limit;
 * it is not a 403, because a stale session token must not break a public page.
 */
async function optionalAuthenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return next();
  // B6 phase 2: with the switch on, a credential never travels in the clear. The
  // answer is 403 https_required before anything is resolved, and it does not count
  // against the address — 31 such calls still answer 403, never 429.
  if (httpsRequired() && !req.secure) {
    return res.status(403).json({ error: 'Потрібне HTTPS-з’єднання', code: 'https_required' });
  }

  try {
    const principal = await resolvePrincipal(token);
    if (principal) req.principal = principal;
    else if (!failedAuth.consume(req.ip)) {
      res.set('Retry-After', String(failedAuth.retryAfterSeconds(req.ip)));
      return res.status(429).json({ error: 'Забагато невдалих спроб входу: спробуйте пізніше' });
    }
  } catch (err) {
    console.error('[AUTH] lookup error:', err.message);
    return res.status(500).json({ error: 'Помилка сервера' });
  }
  next();
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

/**
 * Middleware for `/api/scenarios/:id/...` routes, after `authenticate`: 404 for an unknown
 * scenario, 403 unless the principal may edit it (`canEditScenario`). Runs before a body is
 * read, so a stranger's upload is refused without being received. A route that then changes
 * the row repeats the check under its row lock; this is the cheap early answer.
 */
async function requireScenarioEditor(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT owner_key_id FROM scenarios WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Сценарій не знайдено' });
    if (!canEditScenario(req.principal, rows[0])) return res.status(403).json({ error: 'Це не ваш сценарій' });
  } catch (err) {
    console.error('[AUTH] scenario lookup error:', err.message);
    return res.status(500).json({ error: 'Помилка сервера' });
  }
  next();
}

/** Moderators edit any scenario; an author edits only the ones their key owns. */
function canEditScenario(principal, row) {
  return principal.role === 'moderator'
    || (principal.keyId != null && row.owner_key_id === principal.keyId);
}

/**
 * A start-up warning when the bootstrap ADMIN_TOKEN is set but shorter than
 * {@link MIN_BOOTSTRAP_TOKEN_LENGTH}: it guards every write endpoint, so a
 * guessable one is worth naming. The value itself never appears in the
 * message — a log is not the place for a secret.
 *
 * @returns {string|null} the warning, or null when there is nothing to say
 */
function bootstrapTokenWarning() {
  const token = bootstrapToken();
  if (!token) return null;
  if (token.length >= MIN_BOOTSTRAP_TOKEN_LENGTH) return null;
  return `[AUTH] ADMIN_TOKEN is ${token.length} characters; use at least ${MIN_BOOTSTRAP_TOKEN_LENGTH} — it is the moderator credential every write endpoint trusts`;
}

module.exports = {
  bootstrapToken,
  httpsRequired,
  bootstrapTokenWarning,
  generateToken,
  tokensMatch,
  sha256Hex,
  authenticate,
  optionalAuthenticate,
  requireRole,
  authorize,
  canEditScenario,
  requireScenarioEditor,
};
