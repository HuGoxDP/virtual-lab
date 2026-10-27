// backend/lti/registration.js
//
// LTI Dynamic Registration (1EdTech): the platform opens the tool's registration URL with
// `openid_configuration` and `registration_token`; the tool reads the platform's OpenID configuration,
// registers itself there and stores what comes back.
//
// The registration URL is the only unauthenticated door that makes this server issue an outbound request,
// so it is guarded twice: a secret in the URL (checked by the router) and the SSRF rules below.

const { LtiError, parseHttpsUrl, str } = require('./http');

const NS_TOOL = 'https://purl.imsglobal.org/spec/lti-tool-configuration';
const AGS_SCOPES = [
  'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem',
  'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly',
  'https://purl.imsglobal.org/spec/lti-ags/scope/score',
];

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const UNREACHABLE = 'Не вдалося зв\'язатися з платформою для реєстрації';

/** Reads a JSON body of at most MAX_RESPONSE_BYTES; anything else is a platform fault (502). */
async function readJson(response) {
  if (!response.ok) throw new LtiError(502, UNREACHABLE, `platform answered HTTP ${response.status}`);

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new LtiError(502, UNREACHABLE, 'platform response too large');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new LtiError(502, UNREACHABLE, 'platform response is not JSON');
  }
}

/** One outbound call. Redirects are refused: a 30x could bounce the request (and the token) to another host. */
async function callPlatform(fetchFn, url, init) {
  try {
    const response = await fetchFn(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return await readJson(response);
  } catch (err) {
    if (err instanceof LtiError) throw err;
    throw new LtiError(502, UNREACHABLE, `request to ${url} failed: ${err.message}`);
  }
}

/** Validates the OpenID configuration; returns the fields the tool keeps. */
function checkConfiguration(config, configUrl) {
  const bad = detail => new LtiError(400, 'Конфігурація платформи некоректна або небезпечна', detail);

  if (!config || typeof config !== 'object') throw bad('configuration is not an object');

  const issuer = parseHttpsUrl(str(config.issuer));
  if (!issuer) throw bad('issuer is not an https URL');
  if (issuer.host !== configUrl.host) throw bad('openid_configuration host differs from the issuer host');

  // Every endpoint must sit on the issuer's host: the registration token goes to registration_endpoint, and the
  // others become the URLs the tool later fetches keys from (SSRF) and redirects browsers to.
  const endpoint = key => {
    const url = parseHttpsUrl(str(config[key]));
    if (!url) throw bad(`${key} is not an https URL`);
    if (url.host !== issuer.host) throw bad(`${key} is on a foreign host`);
    return url;
  };

  const registrationEndpoint = endpoint('registration_endpoint');

  return {
    issuer: str(config.issuer),
    authLoginUrl: endpoint('authorization_endpoint').href,
    authTokenUrl: endpoint('token_endpoint').href,
    jwksUri: endpoint('jwks_uri').href,
    registrationEndpoint: registrationEndpoint.href,
    issuerOrigin: issuer.origin,
  };
}

/** The tool's registration request. Only `iss` and `sub` are claimed: no names, no e-mails. */
function buildRegistrationRequest(publicUrl, toolName) {
  const launchUrl = `${publicUrl}/api/lti/launch`;
  return {
    application_type: 'web',
    response_types: ['id_token'],
    grant_types: ['implicit', 'client_credentials'],
    initiate_login_uri: `${publicUrl}/api/lti/login`,
    redirect_uris: [launchUrl],
    client_name: toolName,
    jwks_uri: `${publicUrl}/api/lti/jwks`,
    token_endpoint_auth_method: 'private_key_jwt',
    scope: AGS_SCOPES.join(' '),
    [NS_TOOL]: {
      domain: new URL(publicUrl).host,
      description: 'Інтерактивні 3D-лабораторні роботи',
      target_link_uri: launchUrl,
      claims: ['iss', 'sub'],
      messages: [
        { type: 'LtiDeepLinkingRequest', target_link_uri: launchUrl, label: toolName },
        { type: 'LtiResourceLinkRequest', target_link_uri: launchUrl, label: toolName },
      ],
    },
  };
}

/**
 * Runs the registration handshake and stores the result.
 *
 * @param {{ openid_configuration?: unknown, registration_token?: unknown }} query
 * @returns {Promise<{ issuer: string, clientId: string, issuerOrigin: string }>}
 */
async function registerTool({ query, config, store, fetch: fetchFn }) {
  const configUrl = parseHttpsUrl(str(query.openid_configuration));
  if (!configUrl) throw new LtiError(400, 'Адреса конфігурації платформи має бути https', 'openid_configuration not https');
  const token = str(query.registration_token, 8192);

  const platform = checkConfiguration(await callPlatform(fetchFn, configUrl.href, {
    headers: { Accept: 'application/json' },
  }), configUrl);

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const registered = await callPlatform(fetchFn, platform.registrationEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildRegistrationRequest(config.publicUrl, config.toolName)),
  });

  const clientId = str(registered?.client_id, 255);
  const deploymentId = str(registered?.[NS_TOOL]?.deployment_id, 255);
  if (!clientId || !deploymentId) {
    throw new LtiError(502, 'Платформа не повернула client_id або deployment_id', 'registration response lacks ids');
  }

  await store.saveRegistration({
    issuer: platform.issuer,
    clientId,
    deploymentIds: [deploymentId],
    authLoginUrl: platform.authLoginUrl,
    authTokenUrl: platform.authTokenUrl,
    jwksUri: platform.jwksUri,
  });

  return { issuer: platform.issuer, clientId, issuerOrigin: platform.issuerOrigin };
}

module.exports = { registerTool, buildRegistrationRequest, checkConfiguration, NS_TOOL };
