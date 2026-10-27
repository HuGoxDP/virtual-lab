// backend/lti/launch.js
//
// The two halves of an LTI 1.3 launch:
//   login   OIDC third-party initiation: the platform sends the browser here, we mint a one-time state + nonce
//           and bounce it to the platform's authorization endpoint.
//   launch  the platform posts the signed `id_token` back; we verify it and open a server-side session.
//
// The only thing trusted from the browser is the cookie that proves "this is the browser that started the
// login"; everything else is either a signed claim or a value we generated.

const { jwtVerify, errors: joseErrors } = require('jose');

const {
  LtiError, STATE_COOKIE_PREFIX, SESSION_COOKIE,
  randomToken, sha256Hex, safeEqual, parseCookies, serializeCookie, str, parseHttpsUrl,
} = require('./http');

const CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';
const CLAIMS = {
  messageType: `${CLAIM}message_type`,
  version: `${CLAIM}version`,
  deploymentId: `${CLAIM}deployment_id`,
  targetLinkUri: `${CLAIM}target_link_uri`,
  resourceLink: `${CLAIM}resource_link`,
  roles: `${CLAIM}roles`,
  context: `${CLAIM}context`,
  custom: `${CLAIM}custom`,
  deepLinkSettings: 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings',
  agsEndpoint: 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint',
};

const MESSAGE_TYPES = {
  LtiResourceLinkRequest: 'resource',
  LtiDeepLinkingRequest: 'deep-link',
};

const INSTRUCTOR_ROLES = new Set([
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator',
]);

const CLOCK_TOLERANCE_SECONDS = 5;
const SCENARIO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** `instructor` when any role is an instructor/administrator URI, else `learner` (least privilege). */
function roleFrom(roles) {
  return Array.isArray(roles) && roles.some(r => INSTRUCTOR_ROLES.has(r)) ? 'instructor' : 'learner';
}

/**
 * Which scenario a resource launch is for: the `scenario_id` custom parameter (set by the Deep Linking
 * response) or, failing that, the target link: `/play/<id>` or `?scenario_id=<id>`.
 */
function scenarioIdFrom(customClaim, targetLinkUri) {
  const fromCustom = str(customClaim?.scenario_id, 100);
  if (fromCustom) return SCENARIO_ID.test(fromCustom) ? fromCustom : null;

  let url;
  try { url = new URL(targetLinkUri); } catch { return null; }
  const fromQuery = url.searchParams.get('scenario_id');
  const fromPath = /^\/play\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  let candidate = fromQuery || fromPath || '';
  try { candidate = decodeURIComponent(candidate); } catch { return null; }
  return SCENARIO_ID.test(candidate) ? candidate : null;
}

const bad = (detail, message = 'Запит запуску LTI неповний або некоректний') => new LtiError(400, message, detail);

/**
 * Checks the claims of an already signature-verified token and extracts the session fields.
 * Pure: throws `LtiError`, touches nothing.
 */
function parseLaunchClaims(payload, registration, state) {
  const messageType = MESSAGE_TYPES[payload[CLAIMS.messageType]];
  if (!messageType) throw bad('unsupported or missing message_type');
  if (payload[CLAIMS.version] !== '1.3.0') throw bad('LTI version is not 1.3.0');

  const deploymentId = str(payload[CLAIMS.deploymentId], 255);
  if (!deploymentId) throw bad('deployment_id missing');
  if (!registration.deploymentIds.includes(deploymentId)) {
    throw new LtiError(403, 'Невідоме розгортання (deployment) інструмента', `deployment_id ${deploymentId} not registered`);
  }

  const sub = str(payload.sub, 255);
  if (!sub) throw bad('sub missing');

  const targetLinkUri = str(payload[CLAIMS.targetLinkUri]);
  if (targetLinkUri !== state.targetLinkUri) throw bad('target_link_uri does not match the login request');

  const session = {
    issuer: registration.issuer,
    clientId: registration.clientId,
    deploymentId,
    sub,
    role: roleFrom(payload[CLAIMS.roles]),
    contextId: str(payload[CLAIMS.context]?.id, 255) || null,
    messageType,
    resourceLinkId: null,
    lineitemUrl: null,
    scenarioId: null,
    deepLinkReturnUrl: null,
    deepLinkData: null,
  };

  if (messageType === 'resource') {
    session.resourceLinkId = str(payload[CLAIMS.resourceLink]?.id, 255) || null;
    if (!session.resourceLinkId) throw bad('resource_link.id missing');
    session.lineitemUrl = parseHttpsUrl(str(payload[CLAIMS.agsEndpoint]?.lineitem))?.href ?? null;
    session.scenarioId = scenarioIdFrom(payload[CLAIMS.custom], targetLinkUri);
    if (!session.scenarioId) throw bad('no scenario selected for this activity', 'Для цього завдання не вибрано лабораторну');
  } else {
    const settings = payload[CLAIMS.deepLinkSettings];
    const returnUrl = parseHttpsUrl(str(settings?.deep_link_return_url));
    if (!returnUrl) throw bad('deep_linking_settings.deep_link_return_url missing or not https');
    session.deepLinkReturnUrl = returnUrl.href;
    session.deepLinkData = str(settings.data, 4096) || null;
  }

  return session;
}

function redirectTargetFor(session) {
  return session.messageType === 'deep-link'
    ? '/lti/pick'
    : `/play/${encodeURIComponent(session.scenarioId)}?lti=1`;
}

/** Picks the registration a login belongs to: by client_id when sent, else the issuer's only one. */
async function findRegistrationForLogin(store, issuer, clientId) {
  const registrations = await store.listRegistrations(issuer);
  const matches = clientId ? registrations.filter(r => r.clientId === clientId) : registrations;
  if (matches.length === 0) throw new LtiError(403, 'Платформа не зареєстрована', `unknown issuer ${issuer}`);
  if (matches.length > 1) throw bad('client_id required: several registrations for this issuer');
  return matches[0];
}

/**
 * GET|POST /api/lti/login: OIDC initiation. `params` is the query (GET) or the form body (POST).
 * @returns {Promise<{ redirectUrl: string, cookie: string }>}
 */
async function initiateLogin(params, { store, config }) {
  const issuer = str(params.iss);
  const loginHint = str(params.login_hint);
  const targetLinkUri = str(params.target_link_uri);
  if (!issuer || !loginHint || !targetLinkUri) throw bad('iss, login_hint or target_link_uri missing');

  // The target must be this tool: otherwise the redirect target we later trust is attacker-chosen.
  const target = parseHttpsUrl(targetLinkUri);
  if (!target || target.origin !== config.publicUrl) throw bad('target_link_uri is not on this tool');

  const registration = await findRegistrationForLogin(store, issuer, str(params.client_id));

  const deploymentHint = str(params.lti_deployment_id);
  if (deploymentHint && !registration.deploymentIds.includes(deploymentHint)) {
    throw new LtiError(403, 'Невідоме розгортання (deployment) інструмента', `deployment ${deploymentHint} not registered`);
  }

  const state = randomToken();
  const nonce = randomToken();
  await store.deleteExpired().catch(err => console.error('[LTI] cleanup error:', err.message));
  await store.saveState(
    { state, nonce, issuer: registration.issuer, clientId: registration.clientId, targetLinkUri },
    config.stateTtlSeconds);

  const redirect = new URL(registration.authLoginUrl);
  const query = {
    scope: 'openid',
    response_type: 'id_token',
    response_mode: 'form_post',
    prompt: 'none',
    client_id: registration.clientId,
    redirect_uri: `${config.publicUrl}/api/lti/launch`,
    login_hint: loginHint,
    state,
    nonce,
  };
  const messageHint = str(params.lti_message_hint);
  if (messageHint) query.lti_message_hint = messageHint;
  for (const [key, value] of Object.entries(query)) redirect.searchParams.set(key, value);

  return {
    redirectUrl: redirect.href,
    // One cookie per login, named by its state, so two tabs launching at once do not clobber each other.
    cookie: serializeCookie(STATE_COOKIE_PREFIX + state, state, { maxAgeSeconds: config.stateTtlSeconds, path: '/api/lti' }),
  };
}

function mapVerifyError(err) {
  if (err instanceof joseErrors.JOSEError && err.code !== 'ERR_JWKS_TIMEOUT') {
    return new LtiError(401, 'Недійсний токен запуску LTI', `id_token rejected: ${err.code} ${err.message}`);
  }
  return new LtiError(502, 'Не вдалося перевірити токен запуску: платформа недоступна', `jwks fetch failed: ${err.message}`);
}

/**
 * POST /api/lti/launch: verifies the id_token and opens a session.
 * @returns {Promise<{ redirectUrl: string, cookies: string[] }>}
 */
async function completeLaunch(body, cookieHeader, { store, config, getKeyResolver }) {
  const idToken = str(body.id_token, 16384);
  const state = str(body.state, 256);
  if (!idToken || !state) throw bad('id_token or state missing');

  // Browser binding first, consumption second: without the cookie nobody can burn someone else's state.
  const cookieName = STATE_COOKIE_PREFIX + state;
  const cookieValue = parseCookies(cookieHeader)[cookieName];
  if (!cookieValue || !safeEqual(cookieValue, state)) {
    throw new LtiError(403, 'Сесію входу не знайдено в цьому браузері. Спробуйте запустити ще раз', 'state cookie absent or wrong');
  }

  const saved = await store.consumeState(state);
  if (!saved) throw new LtiError(403, 'Сесія входу застаріла або вже використана', 'state unknown, expired or replayed');

  const registration = await store.getRegistration(saved.issuer, saved.clientId);
  if (!registration) throw new LtiError(403, 'Платформа не зареєстрована', 'registration vanished after login');

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, await getKeyResolver(registration.jwksUri), {
      algorithms: ['RS256'],
      issuer: registration.issuer,
      audience: registration.clientId,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['exp', 'iat', 'iss', 'aud', 'sub', 'nonce'],
    }));
  } catch (err) {
    throw mapVerifyError(err);
  }

  // `aud` may be a list; then the spec requires azp to name us.
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== registration.clientId) {
    throw new LtiError(401, 'Недійсний токен запуску LTI', 'azp does not match client_id');
  }
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, saved.nonce)) {
    throw new LtiError(401, 'Недійсний токен запуску LTI', 'nonce does not match the login');
  }

  const session = parseLaunchClaims(payload, registration, saved);

  const sessionToken = randomToken();
  await store.saveSession(sha256Hex(sessionToken), session, config.sessionTtlSeconds);

  return {
    redirectUrl: redirectTargetFor(session),
    cookies: [
      serializeCookie(SESSION_COOKIE, sessionToken, { maxAgeSeconds: config.sessionTtlSeconds }),
      serializeCookie(cookieName, '', { maxAgeSeconds: 0, path: '/api/lti' }),
    ],
  };
}

module.exports = { initiateLogin, completeLaunch, parseLaunchClaims, roleFrom, scenarioIdFrom, CLAIMS };
