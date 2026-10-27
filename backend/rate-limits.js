// backend/rate-limits.js
//
// Two limits that cannot be a plain per-request `express-rate-limit`:
//   - failed authentication, counted only when the credential was wrong, so a
//     valid key is never limited by anyone else's failures;
//   - author uploads, counted per key rather than per address.
// Both are fixed windows kept in memory (one backend process).

const {
  AUTHOR_UPLOADS_PER_HOUR,
  AUTH_FAILURES_PER_WINDOW,
} = require('./config');

const FAILED_AUTH_WINDOW_MS = 15 * 60 * 1000;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

/** Above this many tracked keys, expired windows are swept so the map cannot grow without bound. */
const SWEEP_THRESHOLD = 10_000;

/**
 * Fixed-window counter. `consume(key)` is true while the key has used fewer
 * than `limit` slots in its current window, and takes one; once exhausted it is
 * false and counts nothing further.
 */
function createWindowCounter({ limit, windowMs, now = Date.now }) {
  const windows = new Map();

  return {
    consume(key) {
      const time = now();
      if (windows.size > SWEEP_THRESHOLD) {
        for (const [k, w] of windows) if (w.resetAt <= time) windows.delete(k);
      }

      let window = windows.get(key);
      if (!window || window.resetAt <= time) {
        window = { count: 0, resetAt: time + windowMs };
        windows.set(key, window);
      }
      if (window.count >= limit) return false;
      window.count++;
      return true;
    },
    /** Seconds until `key` may try again (for `Retry-After`). */
    retryAfterSeconds(key) {
      const window = windows.get(key);
      return window ? Math.max(1, Math.ceil((window.resetAt - now()) / 1000)) : 1;
    },
    reset() {
      windows.clear();
    },
  };
}

const failedAuth = createWindowCounter({ limit: AUTH_FAILURES_PER_WINDOW, windowMs: FAILED_AUTH_WINDOW_MS });
const authorUploads = createWindowCounter({ limit: AUTHOR_UPLOADS_PER_HOUR, windowMs: UPLOAD_WINDOW_MS });

/**
 * Middleware for every route that receives an archive (and for `from-archive`,
 * which arrives in a later phase): an author key may start at most
 * AUTHOR_UPLOADS_PER_HOUR uploads an hour. Runs after `authenticate`; a
 * moderator key or the bootstrap token passes untouched.
 */
function limitAuthorUploads(req, res, next) {
  const { role, keyId } = req.principal;
  if (role !== 'author' || keyId == null) return next();

  if (!authorUploads.consume(keyId)) {
    res.set('Retry-After', String(authorUploads.retryAfterSeconds(keyId)));
    return res.status(429).json({ error: 'Забагато завантажень: спробуйте пізніше' });
  }
  next();
}

module.exports = { createWindowCounter, failedAuth, authorUploads, limitAuthorUploads };
