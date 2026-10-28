// backend/lti/submission.js
//
// What a learner's LTI session may do about a grade: ask whether the work is already submitted, and submit it.
// The platform stores nothing here; "already submitted" is always a question put to the LMS (AGS Results).
// Knows nothing about Express: throws `LtiError`, returns plain objects.

const { LtiError } = require('./http');
const { pinnedUrl, getAccessToken, forgetAccessToken, readResult, postScore } = require('./grades');

const GONE = 'Лабораторну знято';

/** Submissions currently in flight, so a double click cannot post twice before the first answer is known. */
const inFlight = new Set();

/** Anything but an `LtiError` out of the grade calls is our own failure (an unloadable tool key, a bug). */
const UNAVAILABLE = 'Оцінювання тимчасово недоступне на сервері. Спробуйте пізніше';

const clamp01 = value => Math.min(1, Math.max(0, value));

/** A learner on a resource-link launch: the only session a grade may be read or written for. */
const isLearnerOnResource = lti => lti.messageType === 'resource' && lti.role === 'learner';

/** The scenario a session points at when it is published, else a 404. */
async function requirePublishedScenario(store, scenarioId) {
  const scenario = scenarioId ? await store.getScenario(scenarioId) : null;
  if (!scenario?.isPublished) throw new LtiError(404, GONE, `scenario ${scenarioId} unknown or unpublished`);
  return scenario;
}

/** The score to post. A non-graded scenario reports completion (1.0); a graded one its clamped score, 0 if none. */
function resolveScore(graded, raw) {
  if (!graded) return 1;
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new LtiError(400, 'Некоректна оцінка', 'score is not a finite number');
  return clamp01(raw);
}

/** Identifies one learner's work on one line item: the key of the in-flight guard and of the Result cache. */
const workKey = lti => JSON.stringify([lti.issuer, lti.clientId, lti.sub, lti.lineitemUrl]);

/** What to log and answer for a failure that is not an `LtiError`: names the kind, never the message (may hold key material). */
const describeUnexpected = err => `${err?.name ?? 'Error'}${err?.code ? ` ${err.code}` : ''}`;

/**
 * Token + existing result for a session's line item. Any failure is a 502 and claims nothing; one that is not an
 * `LtiError` is passed on as is (callers decide whether it degrades or becomes a 503). A failed Results call drops
 * the cached token: it may be the reason.
 */
async function lookUpResult(lti, registration, deps) {
  pinnedUrl(lti.lineitemUrl, registration, 'line item'); // before a token is requested for nothing
  const token = await getAccessToken(registration, deps);
  try {
    const existing = await readResult({ lineitemUrl: lti.lineitemUrl, sub: lti.sub, token }, registration, deps);
    return { token, existing };
  } catch (err) {
    forgetAccessToken(registration, deps);
    throw err;
  }
}

/**
 * Answer for `GET /api/lti/session`. A failing LMS must not hide the lab, so a failed Result read degrades to
 * `submitted: null` (logged); `submit` asks again and is the authority.
 * @param {object} deps `{ store, fetch, signToolJwt, cache }` (`cache` from grade-cache.js, optional)
 */
async function describeSession(lti, deps) {
  const scenario = lti.scenarioId ? await deps.store.getScenario(lti.scenarioId) : null;

  let submitted = null;
  if (isLearnerOnResource(lti) && lti.lineitemUrl) {
    const registration = await deps.store.getRegistration(lti.issuer, lti.clientId);
    if (registration) {
      const key = workKey(lti);
      const remembered = deps.cache?.results.get(key);
      let existing = remembered?.value ?? null;
      if (!remembered) {
        const ticket = deps.cache?.results.begin();
        try {
          ({ existing } = await lookUpResult(lti, registration, deps));
          deps.cache?.results.set(key, existing, ticket);
        } catch (err) {
          // Degrade, whatever failed: the lab must open. Only an LtiError's detail is safe to print whole.
          if (err instanceof LtiError) console.warn(`[LTI] session: could not read the result (${err.status}): ${err.detail}`);
          else console.error(`[LTI] session: could not read the result, unexpected ${describeUnexpected(err)}`);
        }
      }
      if (existing !== null) submitted = { score: existing };
    }
  }

  return {
    scenarioId: lti.scenarioId,
    role: lti.role,
    messageType: lti.messageType,
    graded: scenario?.graded === true,
    submitted,
  };
}

/**
 * `POST /api/lti/submit`: posts the learner's score to the gradebook, once.
 * @param {number|undefined} rawScore the browser's claim (trusted by decision, only clamped)
 * @returns {Promise<{ score: number }>}
 */
async function submitScore(lti, rawScore, deps) {
  if (!isLearnerOnResource(lti)) {
    throw new LtiError(403, 'Здавати роботу може лише студент', `submit refused for ${lti.role}/${lti.messageType}`);
  }
  const scenario = await requirePublishedScenario(deps.store, lti.scenarioId);
  if (!lti.lineitemUrl) {
    throw new LtiError(409, 'Для цього завдання в Moodle немає оцінки: попросіть викладача додати завдання заново',
      'launch carried no AGS line item');
  }
  const registration = await deps.store.getRegistration(lti.issuer, lti.clientId);
  if (!registration) throw new LtiError(403, 'Платформа не зареєстрована', 'registration vanished');

  const score = resolveScore(scenario.graded, rawScore);

  const key = workKey(lti);
  if (inFlight.has(key)) throw new LtiError(409, 'Роботу вже здають. Зачекайте відповіді', 'duplicate submit in flight');
  inFlight.add(key);
  try {
    // Always asks the LMS: the Result cache serves `describeSession` only, a stale "not submitted" must not
    // let a second grade through. The cached token may be reused.
    const { token, existing } = await lookUpResult(lti, registration, deps);
    if (existing !== null) {
      deps.cache?.results.delete(key);
      throw new LtiError(409, 'Роботу вже здано', `result already present (${existing})`, { score: existing });
    }
    try {
      await postScore({ lineitemUrl: lti.lineitemUrl, sub: lti.sub, score, token }, registration, deps);
    } catch (err) {
      forgetAccessToken(registration, deps);
      throw err;
    }
    deps.cache?.results.delete(key);
  } catch (err) {
    throw err instanceof LtiError
      ? err
      : new LtiError(503, UNAVAILABLE, `grade passback failed, unexpected ${describeUnexpected(err)}`);
  } finally {
    inFlight.delete(key);
  }
  return { score };
}

module.exports = { describeSession, submitScore, requirePublishedScenario, resolveScore, GONE };
