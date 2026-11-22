// backend/lti/manual-registration.js
//
// P1c: the tool-side half of a MANUAL platform registration.
//
// Dynamic Registration (registration.js) is the only path that writes a row on its own:
// `store.saveRegistration` has exactly one caller there, and `launch.js` answers
// 403 «Платформа не зареєстрована» for any issuer it has no row for. An admin whose Moodle
// blocks dynamic registration used to fill Moodle's tool form and get 403 on every launch —
// the form configures Moodle, not the tool. `scripts/lti-add-registration.js` is the missing
// half; this module holds its rules so they are testable without a database.
//
// The rules are the ones the runtime already enforces, stated before anything is written:
//   * every URL https, no credentials (`http.parseHttpsUrl`) — registration.js's stance;
//   * the three platform endpoints on the ISSUER's origin — `grades.js`'s `pinnedUrl` refuses
//     anything else at grade time, so a row that violates it would only fail later;
//   * at least one deployment id — `launch.js` matches the launch's `deployment_id` against
//     this list and answers 403 for an unknown one.

const { parseHttpsUrl } = require('./http');

/** Moodle's own LTI endpoints, relative to the platform origin (`mod/lti`). */
const MOODLE_ENDPOINTS = {
  authLoginUrl: '/mod/lti/auth.php',
  authTokenUrl: '/mod/lti/token.php',
  jwksUri: '/mod/lti/certs.php',
};

/**
 * Validates and normalises one manual registration.
 *
 * @param {{issuer?: unknown, clientId?: unknown, deploymentIds?: unknown,
 *          authLoginUrl?: unknown, authTokenUrl?: unknown, jwksUri?: unknown}} input
 * @returns {{issuer: string, clientId: string, deploymentIds: string[],
 *            authLoginUrl: string, authTokenUrl: string, jwksUri: string}}
 * @throws {Error} with a Ukrainian message naming the offending field
 */
function normaliseRegistration(input) {
  const issuerUrl = parseHttpsUrl(str(input.issuer));
  if (!issuerUrl) throw new Error('issuer має бути https-адресою платформи без логіна й пароля');

  const clientId = str(input.clientId);
  if (!clientId) throw new Error('client_id обов\'язковий (Moodle: «View configuration details» → Client ID)');
  if (clientId.length > 255) throw new Error('client_id довший за 255 символів');

  const deploymentIds = normaliseDeployments(input.deploymentIds);
  if (deploymentIds.length === 0) {
    throw new Error('потрібен хоча б один deployment_id (Moodle: «View configuration details» → Deployment ID)');
  }

  const endpoints = {};
  for (const [field, label] of [
    ['authLoginUrl', 'auth_login_url'],
    ['authTokenUrl', 'auth_token_url'],
    ['jwksUri', 'jwks_uri'],
  ]) {
    const url = parseHttpsUrl(str(input[field]));
    if (!url) throw new Error(`${label} має бути https-адресою без логіна й пароля`);
    if (url.origin !== issuerUrl.origin) {
      throw new Error(`${label} має бути на тому самому хості, що issuer (${issuerUrl.origin})`);
    }
    endpoints[field] = url.href;
  }

  return {
    issuer: issuerUrl.origin,
    clientId,
    deploymentIds,
    ...endpoints,
  };
}

/** Comma/space separated string or array → trimmed, de-duplicated, non-empty ids. */
function normaliseDeployments(value) {
  const list = Array.isArray(value) ? value : str(value).split(/[,\s]+/);
  const out = [];
  for (const raw of list) {
    const id = str(raw).trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = { normaliseRegistration, normaliseDeployments, MOODLE_ENDPOINTS };