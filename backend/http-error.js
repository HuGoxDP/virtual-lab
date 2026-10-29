// backend/http-error.js
//
// Failures a route means to answer with a status. Thrown inside `inTransaction`
// they roll the work back, which is the point: a refusal never leaves half a change.

/** An error carrying the status and the Ukrainian message the client should see. */
const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * What a caught error looks like to a client: `{ status, message }`. A `httpError` (or any error
 * with a 4xx `status`, such as the archive validator's) is itself; anything else is a logged 500
 * with no detail.
 */
function describeError(err, tag) {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) {
    console.error(`[API] ${tag} error:`, err.message);
    return { status, message: 'Помилка сервера' };
  }
  return { status, message: err.message };
}

/** Answers a caught error as `describeError` says. */
function sendError(res, err, tag) {
  const { status, message } = describeError(err, tag);
  res.status(status).json({ error: message });
}

module.exports = { httpError, describeError, sendError };
