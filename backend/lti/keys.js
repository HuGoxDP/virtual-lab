// backend/lti/keys.js
//
// The tool's RSA key pair: signs client assertions and Deep Linking responses (Phase 5) and is
// published as the JWKS the platform fetches. This module is the only one that touches key material.
//
// Source, first match wins:
//   LTI_TOOL_PRIVATE_KEY   PEM text (PKCS#8 or PKCS#1; literal "\n" sequences are accepted)
//   LTI_TOOL_KEY_FILE      path to a PEM file on a volume; created (mode 0600) on first start if absent
//   neither                ephemeral key held in memory, with a warning: every restart changes the key

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { SignJWT, exportJWK, calculateJwkThumbprint, importPKCS8 } = require('jose');

const ALG = 'RS256';
const DEFAULT_TOKEN_LIFETIME = '5m';

function normalizePem(text) {
  // Env files and compose cannot hold a multi-line value, so "\n" typed as backslash + n is accepted.
  return text.replace(/\\n/g, '\n');
}

/** Returns a PKCS#8 PEM string for any private key PEM crypto understands. */
function toPkcs8(pem) {
  return crypto.createPrivateKey(pem).export({ type: 'pkcs8', format: 'pem' });
}

function generatePem() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

async function loadPem(env) {
  if (env.LTI_TOOL_PRIVATE_KEY) return { pem: toPkcs8(normalizePem(env.LTI_TOOL_PRIVATE_KEY)), source: 'env' };

  const file = env.LTI_TOOL_KEY_FILE;
  if (file) {
    try {
      return { pem: toPkcs8(await fs.readFile(file, 'utf8')), source: 'file' };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const pem = generatePem();
    await fs.mkdir(path.dirname(file), { recursive: true });
    // 'wx': never overwrite a key another process wrote between our read and this write.
    await fs.writeFile(file, pem, { mode: 0o600, flag: 'wx' }).catch(async err => {
      if (err.code !== 'EEXIST') throw err;
    });
    return { pem: toPkcs8(await fs.readFile(file, 'utf8')), source: 'file-generated' };
  }

  console.warn('[LTI] No LTI_TOOL_PRIVATE_KEY / LTI_TOOL_KEY_FILE: using an ephemeral key, it changes on every restart');
  return { pem: generatePem(), source: 'ephemeral' };
}

/**
 * @returns {{ getJwks(): Promise<{keys: object[]}>, sign(payload: object): Promise<string>, kid(): Promise<string> }}
 * Loading is lazy and memoised; a failed load is not cached, so a fixed volume works without a restart.
 */
function createKeyStore(env) {
  let loading = null;

  function load() {
    loading ??= (async () => {
      const { pem, source } = await loadPem(env);
      const privateKey = await importPKCS8(pem, ALG, { extractable: true });
      const jwk = await exportJWK(crypto.createPublicKey(pem));
      const kid = await calculateJwkThumbprint(jwk);
      console.log(`[LTI] Tool key ready (${source}), kid ${kid.slice(0, 8)}...`);
      return { privateKey, publicJwk: { ...jwk, kid, alg: ALG, use: 'sig' }, kid };
    })().catch(err => {
      loading = null;
      throw err;
    });
    return loading;
  }

  return {
    async getJwks() {
      return { keys: [(await load()).publicJwk] };
    },
    async kid() {
      return (await load()).kid;
    },
    /** Signs `payload` as RS256; adds `iat` and a 5-minute `exp` unless the caller set them. */
    async sign(payload) {
      const { privateKey, kid } = await load();
      const jwt = new SignJWT(payload).setProtectedHeader({ alg: ALG, kid, typ: 'JWT' });
      if (payload.iat === undefined) jwt.setIssuedAt();
      if (payload.exp === undefined) jwt.setExpirationTime(DEFAULT_TOKEN_LIFETIME);
      return jwt.sign(privateKey);
    },
  };
}

module.exports = { createKeyStore };
