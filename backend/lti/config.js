// backend/lti/config.js
//
// Reads the LTI settings from the environment once. Pure: no I/O, so it is unit-testable.

/** OIDC login state lifetime: long enough for a slow platform redirect, short enough to be useless later. */
const STATE_TTL_SECONDS = 10 * 60;

/** Default session lifetime; a lab session is one sitting. */
const DEFAULT_SESSION_TTL_SECONDS = 4 * 60 * 60;

const DEFAULT_RATE_LIMIT = 600;

function positiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * @returns {{
 *   publicUrl: string|null, registrationSecret: string|null, sessionTtlSeconds: number,
 *   stateTtlSeconds: number, rateLimit: number, toolName: string
 * }}
 * `publicUrl` is the tool's own origin ("https://lab.example"), without a trailing slash; null when unset or
 * not https. The tool refuses to run without it: the registration it sends to the platform is built from it.
 */
function readConfig(env) {
  let publicUrl = null;
  if (env.LTI_PUBLIC_URL) {
    try {
      const url = new URL(env.LTI_PUBLIC_URL);
      if (url.protocol === 'https:') publicUrl = url.origin;
    } catch { /* stays null: reported as "not configured" */ }
  }

  return {
    publicUrl,
    registrationSecret: env.LTI_REGISTRATION_SECRET || null,
    sessionTtlSeconds: positiveInt(env.LTI_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS),
    stateTtlSeconds: STATE_TTL_SECONDS,
    rateLimit: positiveInt(env.LTI_RATE_LIMIT, DEFAULT_RATE_LIMIT),
    toolName: env.LTI_TOOL_NAME || 'Віртуальна 3D Лабораторія',
  };
}

module.exports = { readConfig, STATE_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS };
