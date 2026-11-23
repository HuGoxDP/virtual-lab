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
//   * the issuer is stored VERBATIM (trimmed input, `str(input.issuer)`), exactly like
//     Dynamic Registration stores it (registration.js:80): store lookups are exact string
//     matches, so a Moodle on a sub-path (https://host/moodle) must keep its path;
//   * the three platform endpoints on the ISSUER's origin — `grades.js`'s `pinnedUrl` refuses
//     anything else at grade time, so a row that violates it would only fail later;
//   * at least one deployment id, each at most 255 chars — `launch.js` matches the launch's
//     `deployment_id` (read with `str(payload, 255)`) against this list and answers 403 for
//     an unknown one, so a longer id could never match.

const { parseHttpsUrl } = require('./http');

/** Moodle's own LTI endpoints, relative to the platform origin (`mod/lti`). */
const MOODLE_ENDPOINTS = {
  authLoginUrl: '/mod/lti/auth.php',
  authTokenUrl: '/mod/lti/token.php',
  jwksUri: '/mod/lti/certs.php',
};

/**
 * Validates and normalises one manual registration. The issuer is kept exactly as given
 * (trimmed), like registration.js stores it — the store's lookups are exact matches, so a
 * sub-path issuer must not be reduced to its origin. `parseHttpsUrl` only validates it.
 *
 * @param {{issuer?: unknown, clientId?: unknown, deploymentIds?: unknown,
 *          authLoginUrl?: unknown, authTokenUrl?: unknown, jwksUri?: unknown}} input
 * @returns {{issuer: string, clientId: string, deploymentIds: string[],
 *            authLoginUrl: string, authTokenUrl: string, jwksUri: string}}
 * @throws {Error} with a Ukrainian message naming the offending field
 */
function normaliseRegistration(input) {
  const issuer = str(input.issuer);
  const issuerUrl = parseHttpsUrl(issuer);
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
    issuer,
    clientId,
    deploymentIds,
    ...endpoints,
  };
}

/** Comma/space separated string or array → trimmed, de-duplicated, non-empty ids (max 255 chars). */
function normaliseDeployments(value) {
  const list = Array.isArray(value) ? value : str(value).split(/[,\s]+/);
  const out = [];
  for (const raw of list) {
    const id = str(raw).trim();
    // launch.js reads the claim with str(payload, 255): a longer id could never match.
    if (id.length > 255) throw new Error('deployment_id довший за 255 символів');
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = { normaliseRegistration, normaliseDeployments, MOODLE_ENDPOINTS };