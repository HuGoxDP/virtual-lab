// backend/lti/grades.js
//
// LTI Assignment and Grade Services client: client-credentials token, Result read, Score post.
// Knows nothing about Express. The platform keeps the grade; this module only talks to it.
//
// Outbound URLs come from a signed launch claim (line item) and the registration (token endpoint), but both are
// still pinned to the issuer's origin, https only, redirects refused: the same SSRF stance as registration.js.

const crypto = require('node:crypto');

const { LtiError, parseHttpsUrl } = require('./http');

const AGS = 'https://purl.imsglobal.org/spec/lti-ags/scope/';
/** The scopes Dynamic Registration asked for (registration.js); a token may not claim more. */
const SCOPES = [`${AGS}lineitem`, `${AGS}result.readonly`, `${AGS}score`].join(' ');

const RESULT_MEDIA_TYPE = 'application/vnd.ims.lis.v2.resultcontainer+json';
const SCORE_MEDIA_TYPE = 'application/vnd.ims.lis.v1.score+json';
const SCORE_MAXIMUM = 100;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const PLATFORM_FAILED = 'Не вдалося зв\'язатися з Moodle. Спробуйте пізніше';

const fail = detail => new LtiError(502, PLATFORM_FAILED, detail);

/** Parses `value` as an https URL on the registration's issuer host, or throws a 502. */
function pinnedUrl(value, registration, what) {
  const url = parseHttpsUrl(value);
  const issuer = parseHttpsUrl(registration.issuer);
  if (!url || !issuer || url.origin !== issuer.origin) throw fail(`${what} is not an https URL on the issuer host`);
  return url;
}

/** One bounded request; returns `{ status, text }`. Network errors and oversize bodies become 502. */
async function send(fetchFn, url, init, what) {
  let response;
  try {
    response = await fetchFn(url.href, { ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw fail(`${what} request failed: ${err.message}`);
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw fail(`${what} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      chunks.push(chunk);
    }
  } catch (err) {
    throw err instanceof LtiError ? err : fail(`${what} response could not be read: ${err.message}`);
  }
  return { status: response.status, text: Buffer.concat(chunks).toString('utf8') };
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw fail(`${what} answered with invalid JSON`);
  }
}

/** `{lineitem}/suffix` keeping the line item's own query string (Moodle's line item URL has one). */
function lineItemSubUrl(lineitemUrl, suffix) {
  const url = new URL(lineitemUrl.href);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix}`;
  return url;
}

const tokenCacheKey = (registration, tokenUrl) =>
  JSON.stringify([registration.issuer, registration.clientId, tokenUrl.href, SCOPES]);

/**
 * Client-credentials access token for the AGS scopes: the tool authenticates with a signed JWT assertion.
 * Reused from `cache.tokens` until shortly before the platform's `expires_in` (a reply without one is not cached).
 * @param {{ fetch: Function, signToolJwt: Function, cache?: object }} deps
 * @returns {Promise<string>}
 */
async function getAccessToken(registration, { fetch: fetchFn, signToolJwt, cache }) {
  const tokenUrl = pinnedUrl(registration.authTokenUrl, registration, 'token endpoint');
  const cacheKey = tokenCacheKey(registration, tokenUrl);
  const cached = cache?.tokens.get(cacheKey);
  if (cached) return cached;

  const assertion = await signToolJwt({
    iss: registration.clientId,
    sub: registration.clientId,
    aud: tokenUrl.href,
    jti: crypto.randomUUID(),
  });

  const { status, text } = await send(fetchFn, tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      scope: SCOPES,
    }).toString(),
  }, 'token');
  if (status !== 200) throw fail(`token endpoint answered HTTP ${status}`);

  const reply = parseJson(text, 'token endpoint');
  const token = reply.access_token;
  if (typeof token !== 'string' || !token) throw fail('token endpoint returned no access_token');
  cache?.tokens.set(cacheKey, token, Number(reply.expires_in));
  return token;
}

/** Drops the cached token, e.g. after the platform refused it, so the next call asks for a fresh one. */
function forgetAccessToken(registration, { cache }) {
  const tokenUrl = parseHttpsUrl(registration.authTokenUrl);
  if (tokenUrl) cache?.tokens.delete(tokenCacheKey(registration, tokenUrl));
}

/**
 * The learner's existing grade for this line item, whoever put it there, as a fraction 0..1; null when none.
 * @returns {Promise<number|null>}
 */
async function readResult({ lineitemUrl, sub, token }, registration, { fetch: fetchFn }) {
  const url = lineItemSubUrl(pinnedUrl(lineitemUrl, registration, 'line item'), 'results');
  url.searchParams.set('user_id', sub);

  const { status, text } = await send(fetchFn, url, {
    headers: { Authorization: `Bearer ${token}`, Accept: RESULT_MEDIA_TYPE },
  }, 'results');
  if (status !== 200) throw fail(`results endpoint answered HTTP ${status}`);

  const results = parseJson(text, 'results endpoint');
  if (!Array.isArray(results)) throw fail('results endpoint did not return a list');

  // Filter on userId too: a platform that ignores `user_id` must not make someone else's grade ours.
  const mine = results.find(r => r && String(r.userId) === sub && Number.isFinite(r.resultScore));
  if (!mine) return null;
  const maximum = Number.isFinite(mine.resultMaximum) && mine.resultMaximum > 0 ? mine.resultMaximum : SCORE_MAXIMUM;
  return Math.min(1, Math.max(0, mine.resultScore / maximum));
}

/** Posts a final, fully graded score. `score` is a fraction 0..1. */
async function postScore({ lineitemUrl, sub, score, token }, registration, { fetch: fetchFn }) {
  const url = lineItemSubUrl(pinnedUrl(lineitemUrl, registration, 'line item'), 'scores');

  const { status } = await send(fetchFn, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': SCORE_MEDIA_TYPE, Accept: 'application/json' },
    body: JSON.stringify({
      userId: sub,
      scoreGiven: Math.round(score * SCORE_MAXIMUM * 100) / 100,
      scoreMaximum: SCORE_MAXIMUM,
      activityProgress: 'Completed',
      gradingProgress: 'FullyGraded',
      timestamp: new Date().toISOString(),
    }),
  }, 'score');
  if (status < 200 || status >= 300) throw fail(`score endpoint answered HTTP ${status}`);
}

module.exports = { pinnedUrl, getAccessToken, forgetAccessToken, readResult, postScore, SCOPES, SCORE_MAXIMUM, RESULT_MEDIA_TYPE, SCORE_MEDIA_TYPE };
