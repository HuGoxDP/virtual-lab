// backend/lti/http.js
//
// Small HTTP-level helpers shared by the LTI handlers: the expected-failure error type, cookies, tokens.

const crypto = require('node:crypto');

/**
 * A rejection the caller should see: `status` + a Ukrainian `message`; `detail` goes to the log only;
 * `extra` fields are merged into the JSON body next to `error`.
 */
class LtiError extends Error {
  constructor(status, message, detail, extra) {
    super(message);
    this.status = status;
    this.detail = detail || message;
    this.extra = extra;
  }
}

const SESSION_COOKIE = 'lti_session';
const STATE_COOKIE_PREFIX = 'lti_state_';

/** 256 random bits, URL-safe. */
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string equality (length checked first: timingSafeEqual throws on a mismatch). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const cookies = {};
  for (const raw of String(header || '').split(';')) {
    const part = raw.trim();
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

/**
 * Every LTI cookie is `SameSite=None; Secure; HttpOnly; Partitioned`: the launch is a cross-site form POST from
 * the LMS, which a Lax cookie would not accompany, and Moodle's "Select content" runs the whole chain inside an
 * iframe on the LMS origin, where these are third-party cookies. `Partitioned` (CHIPS) keeps them allowed there,
 * keyed to the embedding site, so the framed session is separate from the same user's new-window session.
 * `maxAgeSeconds = 0` clears it (the clearing header must carry the same attributes to hit the same cookie).
 */
function serializeCookie(name, value, { maxAgeSeconds, path = '/' }) {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=None; Partitioned`;
}

/** A query/body field as a bounded non-empty string, or '' for anything else (arrays, objects, absent). */
function str(value, max = 4096) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

/** Parses an https URL without credentials, or returns null. */
function parseHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

module.exports = {
  LtiError, SESSION_COOKIE, STATE_COOKIE_PREFIX,
  randomToken, sha256Hex, safeEqual, parseCookies, serializeCookie, str, parseHttpsUrl,
};
