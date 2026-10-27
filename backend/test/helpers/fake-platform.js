// backend/test/helpers/fake-platform.js
//
// A stand-in for Moodle: its own RSA keys, the OpenID configuration and registration endpoint
// (as an injectable `fetch`), a local JWKS resolver, and a signer for id_tokens. Nothing here knows how
// the tool validates; tests tamper with the tokens it produces.

const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = require('jose');

const PLATFORM = 'https://moodle.test';
const TOOL = 'https://tool.test';
const LAUNCH_URL = `${TOOL}/api/lti/launch`;
const CLIENT_ID = 'client-1';
const DEPLOYMENT_ID = '1';
const REGISTRATION_TOKEN = 'reg-token-123';

const CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/';
const NS_TOOL = 'https://purl.imsglobal.org/spec/lti-tool-configuration';
const LEARNER = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
const INSTRUCTOR = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';

/** The registration row a successful Dynamic Registration would have stored. */
const REGISTRATION = {
  issuer: PLATFORM,
  clientId: CLIENT_ID,
  deploymentIds: [DEPLOYMENT_ID],
  authLoginUrl: `${PLATFORM}/auth`,
  authTokenUrl: `${PLATFORM}/token`,
  jwksUri: `${PLATFORM}/jwks`,
};

/** A well-formed resource-link launch payload. Pass `nonce`; override or delete claims per test. */
function resourceClaims(nonce, overrides = {}) {
  return {
    iss: PLATFORM,
    aud: CLIENT_ID,
    sub: 'user-1',
    nonce,
    name: 'Іван Петренко',
    email: 'ivan@moodle.test',
    [`${CLAIM}message_type`]: 'LtiResourceLinkRequest',
    [`${CLAIM}version`]: '1.3.0',
    [`${CLAIM}deployment_id`]: DEPLOYMENT_ID,
    [`${CLAIM}target_link_uri`]: LAUNCH_URL,
    [`${CLAIM}resource_link`]: { id: 'rl-1' },
    [`${CLAIM}roles`]: [LEARNER],
    [`${CLAIM}context`]: { id: 'course-1' },
    [`${CLAIM}custom`]: { scenario_id: 'circuits' },
    'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint': { lineitem: `${PLATFORM}/lineitem/7` },
    ...overrides,
  };
}

function deepLinkClaims(nonce, overrides = {}) {
  const claims = resourceClaims(nonce, {
    [`${CLAIM}message_type`]: 'LtiDeepLinkingRequest',
    [`${CLAIM}roles`]: [INSTRUCTOR],
    'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings': {
      deep_link_return_url: `${PLATFORM}/deeplink/return`,
      accept_types: ['ltiResourceLink'],
      data: 'opaque-data-1',
    },
    ...overrides,
  });
  delete claims[`${CLAIM}resource_link`];
  delete claims[`${CLAIM}custom`];
  return claims;
}

const jsonResponse = (body, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function createFakePlatform() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fake-1', alg: 'RS256', use: 'sig' };

  const platform = {
    jwks: { keys: [jwk] },
    privateKey,
    /** A key the tool has never heard of, for forged signatures. */
    forgingKey: other.privateKey,
    getKeyResolver: () => createLocalJWKSet({ keys: [jwk] }),

    /** The OpenID configuration document; tests mutate it to break things. */
    config: {
      issuer: PLATFORM,
      authorization_endpoint: `${PLATFORM}/auth`,
      token_endpoint: `${PLATFORM}/token`,
      jwks_uri: `${PLATFORM}/jwks`,
      registration_endpoint: `${PLATFORM}/registration`,
    },
    /** What the registration endpoint answers (status + body); tests mutate it. */
    registrationReply: {
      status: 200,
      body: { client_id: CLIENT_ID, [NS_TOOL]: { deployment_id: DEPLOYMENT_ID } },
    },
    /** Every request the tool made: `{ url, init }`. */
    calls: [],
    /** Bodies POSTed to the registration endpoint. */
    registrations: [],

    /** The injected `fetch`. */
    async fetch(url, init = {}) {
      platform.calls.push({ url, init });
      if (url === `${PLATFORM}/.well-known/openid-configuration`) return jsonResponse(platform.config);
      if (url === platform.config.registration_endpoint || url === `${PLATFORM}/registration`) {
        if (init.headers?.Authorization !== `Bearer ${REGISTRATION_TOKEN}`) return jsonResponse({}, 401);
        platform.registrations.push(JSON.parse(init.body));
        return jsonResponse(platform.registrationReply.body, platform.registrationReply.status);
      }
      return jsonResponse({}, 404);
    },

    /** Signs `claims` as the platform. `alg`, `key`, `kid`, `exp` are for forging. */
    async sign(claims, { key = privateKey, alg = 'RS256', kid = 'fake-1', exp = '5m', iat = true } = {}) {
      const jwt = new SignJWT(claims).setProtectedHeader({ alg, kid });
      if (iat) jwt.setIssuedAt();
      if (exp) jwt.setExpirationTime(exp);
      return jwt.sign(key);
    },
  };
  platform.fetch = platform.fetch.bind(platform);
  return platform;
}

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token with `alg: none` and no signature. */
function unsignedToken(claims) {
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000) })}.`;
}

module.exports = {
  PLATFORM, TOOL, LAUNCH_URL, CLIENT_ID, DEPLOYMENT_ID, REGISTRATION_TOKEN, REGISTRATION, CLAIM, NS_TOOL,
  LEARNER, INSTRUCTOR,
  createFakePlatform, resourceClaims, deepLinkClaims, unsignedToken,
};
