// backend/http-error.js
//
// Failures a route means to answer with a status. Thrown inside `inTransaction`
// they roll the work back, which is the point: a refusal never leaves half a change.

/** An error carrying the status and the Ukrainian message the client should see. */
const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Answers a caught error: a `httpError` (or any error with a 4xx `status`, such as
 * the archive validator's) as itself, anything else as a logged 500 with no detail.
 */
function sendError(res, err, tag) {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) {
    console.error(`[API] ${tag} error:`, err.message);
    return res.status(500).json({ error: 'Помилка сервера' });
  }
  res.status(status).json({ error: err.message });
}

module.exports = { httpError, sendError };
