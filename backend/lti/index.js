// backend/lti/index.js
//
// LTI 1.3 tool for LMS platforms (Moodle first): Dynamic Registration, OIDC login, launch, server-side session.
// Mounted by server.js at /api/lti. The rest of the backend knows only what this file exports.
//
//   GET      /jwks       the tool's public keys
//   GET      /register   Dynamic Registration (guarded by LTI_REGISTRATION_SECRET in the URL)
//   GET|POST /login      OIDC initiation
//   POST     /launch     id_token validation, session, redirect into the SPA
//   GET      /session    what the session may do (scenario, role, graded, already submitted)
//   POST     /submit     learner's score to the LMS gradebook, once (JSON body only)
//   POST     /deep-link  teacher's pick: signed Deep Linking response, as an auto-submit page
//
// Environment: LTI_PUBLIC_URL (https origin of this tool, required), LTI_REGISTRATION_SECRET,
// LTI_TOOL_PRIVATE_KEY | LTI_TOOL_KEY_FILE, LTI_SESSION_TTL_SECONDS, LTI_RATE_LIMIT. See .env.example.
//
// Layering: handlers here only translate HTTP; `launch.js` / `registration.js` hold the protocol rules and
// know nothing about Express; `store.js` is the only SQL; `keys.js` is the only key material.

const crypto = require('node:crypto');

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createRemoteJWKSet } = require('jose');

const { readConfig } = require('./config');
const { createKeyStore } = require('./keys');
const { createStore } = require('./store');
const { createRequireLtiSession } = require('./session');
const { registerTool } = require('./registration');
const { initiateLogin, completeLaunch } = require('./launch');
const { LtiError, safeEqual, str, parseHttpsUrl } = require('./http');
const { describeSession, submitScore, requirePublishedScenario } = require('./submission');
const { buildDeepLinkClaims, deepLinkPage } = require('./deeplink');

const RATE_WINDOW_MS = 15 * 60 * 1000;
const FORM_BODY_LIMIT = '100kb';
const JSON_BODY_LIMIT = '10kb';
const JWKS_TIMEOUT_MS = 5_000;

/** CSP of every response unless a handler widens it: these endpoints return JSON or redirects, never a page. */
const LOCKED_DOWN_CSP = "default-src 'none'; frame-ancestors 'none'";

/** Shorter secrets are guessable within the rate limit; registration stays closed until a real one is set. */
const MIN_REGISTRATION_SECRET_LENGTH = 16;

const NOT_CONFIGURED = 'LTI не налаштовано на цьому сервері';

/** The process-wide context behind `getRegistration` / `signToolJwt` / `requireLtiSession`. One router per process. */
let current = null;

function requireContext() {
  if (!current) throw new Error('LTI module used before createLtiRouter()');
  return current;
}

/** Remote JWKS resolvers, one per platform key-set URL. Bounded by the number of registrations. */
function createRemoteKeyResolverCache() {
  const resolvers = new Map();
  return jwksUri => {
    if (!resolvers.has(jwksUri)) {
      resolvers.set(jwksUri, createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: JWKS_TIMEOUT_MS }));
    }
    return resolvers.get(jwksUri);
  };
}

/** The page that ends Dynamic Registration: tells the platform's window (opener or parent frame) we are done. */
function registrationDonePage(nonce) {
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Реєстрацію завершено</title>
<style nonce="${nonce}">body{font:16px system-ui,sans-serif;margin:3rem auto;max-width:32rem;text-align:center}</style>
</head><body>
<h1>Інструмент зареєстровано</h1>
<p>Віртуальну 3D Лабораторію додано до платформи. Це вікно можна закрити.</p>
<script nonce="${nonce}">(window.opener || window.parent).postMessage({ subject: 'org.imsglobal.lti.close' }, '*');</script>
</body></html>`;
}

/**
 * @param {{ pool: import('pg').Pool, env?: NodeJS.ProcessEnv,
 *           fetch?: typeof fetch, getKeyResolver?: (jwksUri: string) => unknown }} deps
 *   `fetch` and `getKeyResolver` exist so tests can stand in for the platform; production uses the defaults.
 * @returns {import('express').Router}
 */
function createLtiRouter({ pool, env = process.env, fetch: fetchFn = globalThis.fetch, getKeyResolver }) {
  const config = readConfig(env);
  const store = createStore(pool);
  const keys = createKeyStore(env);
  const resolveKeys = getKeyResolver ?? createRemoteKeyResolverCache();

  current = { store, keys, config, requireLtiSession: createRequireLtiSession(store) };

  if (!config.publicUrl) {
    console.warn('[LTI] LTI_PUBLIC_URL is not set to an https URL: /api/lti is disabled');
  }

  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Content-Security-Policy', LOCKED_DOWN_CSP);
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.use((req, res, next) => {
    if (!config.publicUrl) return res.status(503).json({ error: NOT_CONFIGURED });
    next();
  });

  router.use(rateLimit({
    windowMs: RATE_WINDOW_MS,
    limit: config.rateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Забагато запитів. Спробуйте пізніше' },
  }));

  router.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));
  router.use(express.json({ limit: JSON_BODY_LIMIT }));

  /** Wraps a handler: expected failures become `{ error }` with their status, anything else a logged 500. */
  const handle = (name, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof LtiError) {
        console.warn(`[LTI] ${name} rejected (${err.status}): ${err.detail}`);
        return res.status(err.status).json({ error: err.message, ...err.extra });
      }
      console.error(`[LTI] ${name} error:`, err.message);
      res.status(500).json({ error: 'Помилка сервера' });
    }
  };

  // ── GET /api/lti/jwks ──
  router.get('/jwks', handle('jwks', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(await keys.getJwks());
  }));

  // ── GET /api/lti/register ──
  // The secret is part of the URL the admin pastes into the LMS; the LMS appends its own query parameters.
  function requireRegistrationSecret(req, res, next) {
    if (!config.registrationSecret) {
      return res.status(503).json({ error: 'Реєстрацію інструмента не налаштовано' });
    }
    if (config.registrationSecret.length < MIN_REGISTRATION_SECRET_LENGTH) {
      console.error(`[LTI] register refused: LTI_REGISTRATION_SECRET is shorter than ${MIN_REGISTRATION_SECRET_LENGTH} characters`);
      return res.status(503).json({ error: 'Секрет реєстрації занадто короткий: реєстрацію вимкнено' });
    }
    const provided = str(req.query.secret, 512);
    if (!provided) return res.status(401).json({ error: 'Потрібен секрет реєстрації' });
    if (!safeEqual(provided, config.registrationSecret)) {
      return res.status(403).json({ error: 'Невірний секрет реєстрації' });
    }
    next();
  }

  router.get('/register', requireRegistrationSecret, handle('register', async (req, res) => {
    const { issuer, clientId, issuerOrigin } = await registerTool({ query: req.query, config, store, fetch: fetchFn });
    console.log(`[LTI] registered platform ${issuer} as client ${clientId}`);

    const nonce = crypto.randomBytes(16).toString('base64');
    // Shown inside the platform's own frame: only that origin may embed it, and only our nonce'd code runs.
    res.set('Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors ${issuerOrigin}`);
    res.type('html').send(registrationDonePage(nonce));
  }));

  // ── GET|POST /api/lti/login ──
  const login = handle('login', async (req, res) => {
    const { redirectUrl, cookie } = await initiateLogin(req.method === 'GET' ? req.query : req.body, { store, config });
    res.append('Set-Cookie', cookie);
    res.redirect(302, redirectUrl);
  });
  router.get('/login', login);
  router.post('/login', login);

  // ── POST /api/lti/launch ──
  router.post('/launch', handle('launch', async (req, res) => {
    const { redirectUrl, cookies } = await completeLaunch(req.body, req.get('cookie'), {
      store, config, getKeyResolver: resolveKeys,
    });
    for (const cookie of cookies) res.append('Set-Cookie', cookie);
    // 303: the follow-up is a GET even though the platform's request was a POST.
    res.redirect(303, redirectUrl);
  }));

  // ── Session-bound endpoints ──
  // The session cookie is SameSite=None, so a foreign page could make the browser send it. State-changing
  // requests therefore must come from this tool's own origin (Origin / Sec-Fetch-Site, when the browser sends them).
  const sessionBound = [requireLtiSession];
  const sameOriginOnly = (req, res, next) => {
    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    if ((origin && origin !== config.publicUrl) || (site && site !== 'same-origin' && site !== 'none')) {
      return res.status(403).json({ error: 'Запит з чужого джерела відхилено' });
    }
    next();
  };
  const grades = () => ({ store, fetch: fetchFn, signToolJwt });

  // ── GET /api/lti/session ──
  router.get('/session', sessionBound, handle('session', async (req, res) => {
    res.json(await describeSession(req.lti, grades()));
  }));

  // ── POST /api/lti/submit ──
  // JSON only: a cross-site HTML form cannot send application/json without a CORS preflight.
  router.post('/submit', sameOriginOnly, sessionBound, handle('submit', async (req, res) => {
    if (!req.is('application/json')) throw new LtiError(415, 'Очікується JSON', 'submit needs application/json');
    res.json(await submitScore(req.lti, req.body?.score, grades()));
  }));

  // ── POST /api/lti/deep-link ──
  router.post('/deep-link', sameOriginOnly, sessionBound, handle('deep-link', async (req, res) => {
    const lti = req.lti;
    if (lti.messageType !== 'deep-link' || lti.role !== 'instructor' || !lti.deepLinkReturnUrl) {
      throw new LtiError(403, 'Вибір лабораторної доступний лише викладачу з вікна вибору в LMS',
        `deep-link refused for ${lti.role}/${lti.messageType}`);
    }
    const scenarioId = str(req.body?.scenarioId, 100);
    if (!scenarioId) throw new LtiError(400, 'Не вказано лабораторну', 'scenarioId missing');
    const scenario = await requirePublishedScenario(store, scenarioId);

    const registration = await store.getRegistration(lti.issuer, lti.clientId);
    if (!registration) throw new LtiError(403, 'Платформа не зареєстрована', 'registration vanished');

    // The browser is sent there with a signed token: it must be the platform's own host, like every other endpoint.
    const returnUrl = parseHttpsUrl(lti.deepLinkReturnUrl);
    if (!returnUrl || returnUrl.origin !== new URL(registration.issuer).origin) {
      throw new LtiError(403, 'Некоректна адреса повернення до LMS', 'deep_link_return_url is not on the issuer host');
    }

    const claims = buildDeepLinkClaims({ session: lti, scenario, launchUrl: `${config.publicUrl}/api/lti/launch` });
    const jwt = await keys.sign(claims);

    const nonce = crypto.randomBytes(16).toString('base64');
    // Its own policy (nginx leaves /api/lti/ alone): our nonce'd script runs, the form may go only to the
    // platform, and only the platform may frame the page.
    res.set('Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${returnUrl.origin}; frame-ancestors ${returnUrl.origin}`);
    res.type('html').send(deepLinkPage({ returnUrl: returnUrl.href, jwt, nonce }));
  }));

  // Body-parser failures (oversized or malformed form) would otherwise reach Express's HTML error page.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const tooLarge = err.status === 413;
    res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'Запит завеликий' : 'Некоректний запит' });
  });

  return router;
}

/** @returns {Promise<Registration|null>} the stored registration, or null when this (issuer, clientId) is unknown. */
function getRegistration(issuer, clientId) {
  return requireContext().store.getRegistration(issuer, clientId);
}

/** Signs `payload` as an RS256 JWT with the tool's key (`kid` as published at /api/lti/jwks). */
function signToolJwt(payload) {
  return requireContext().keys.sign(payload);
}

/** Express middleware: resolves the `lti_session` cookie and sets `req.lti`, or answers 401. */
function requireLtiSession(req, res, next) {
  if (!current) return res.status(503).json({ error: NOT_CONFIGURED });
  return current.requireLtiSession(req, res, next);
}

/**
 * @typedef {{ issuer: string, clientId: string, deploymentIds: string[],
 *             authLoginUrl: string, authTokenUrl: string, jwksUri: string }} Registration
 */

module.exports = { createLtiRouter, createRemoteKeyResolverCache, getRegistration, signToolJwt, requireLtiSession };
