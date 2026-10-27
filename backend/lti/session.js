// backend/lti/session.js
//
// `requireLtiSession`: resolves the `lti_session` cookie to the server-side session row.

const { SESSION_COOKIE, parseCookies, sha256Hex } = require('./http');

/**
 * Express middleware factory. Sets `req.lti` and calls next(), or answers 401.
 * The cookie holds a random token; the table is keyed by its sha256.
 */
function createRequireLtiSession(store) {
  return async function requireLtiSession(req, res, next) {
    const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Потрібен вхід через LMS' });

    try {
      const session = await store.findSession(sha256Hex(token));
      if (!session) return res.status(401).json({ error: 'Сесія LTI завершилась. Відкрийте завдання з LMS ще раз' });
      req.lti = session;
      next();
    } catch (err) {
      console.error('[LTI] session lookup error:', err.message);
      res.status(500).json({ error: 'Помилка сервера' });
    }
  };
}

module.exports = { createRequireLtiSession };
