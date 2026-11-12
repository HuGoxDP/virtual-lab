// ops/deploy/lib/config.mjs
//
// `.workers/deploy.env`, parsed (decision D-13). The file is untracked — it never
// reaches a commit — so the parser is the only gate: every value is validated
// here rather than on the server, and an error names the key and never the
// value, so a message that ends up in a log or an ATTENTION line cannot carry a
// secret.
//
// The format is deliberately minimal (`KEY=value`, `#` comments, no shell
// expansion): a file that is `source`d by a shell is a file whose values can be
// substituted into each other, and this one must not be.

const REQUIRED = ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_KEY', 'DEPLOY_DOMAIN', 'DEPLOY_PATH'];
const OPTIONAL = { DEPLOY_PORT: '22', DEPLOY_HOSTKEY: '' };
const KEYS = new Set([...REQUIRED, ...Object.keys(OPTIONAL)]);

const HOST = /^[A-Za-z0-9.-]+$/;
const USER = /^[a-z_][a-z0-9_-]*$/;
const ABSPATH = /^\//;
const BADPATH = /[\s'";`$&|<>(){}[\]!#*?~]/;

/** An IPv4 literal in dot-quad form, which passes HOST but should not be mistaken for a name. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const fail = (key, why) => {
  const err = new Error(`deploy.env: ${key} ${why}`);
  // `status` rather than a throw so a caller can show the key alongside the exit
  // code; the message carries the key name and never a value.
  err.key = key;
  return err;
};

/**
 * Parses and validates `deploy.env` text.
 *
 * @param {string} text — the file's contents.
 * @returns {{DEPLOY_HOST: string, DEPLOY_USER: string, DEPLOY_KEY: string,
 *           DEPLOY_DOMAIN: string, DEPLOY_PATH: string, DEPLOY_PORT: string,
 *           DEPLOY_HOSTKEY: string}}
 * @throws {Error & {key: string}} on any unknown, missing or invalid entry.
 */
export function parseDeployEnv(text) {
  const raw = {};
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq < 1) {
      throw fail(`line ${index + 1}`, 'is not `KEY=value`');
    }
    const key = trimmed.slice(0, eq).trim();
    if (!KEYS.has(key)) throw fail(key, 'is not a deploy.env key');
    // The first `=` wins: a value may contain `=` (a host key's signature does).
    raw[key] = trimmed.slice(eq + 1).trim();
  });

  for (const key of REQUIRED) {
    if (!raw[key]) throw fail(key, 'is required and must not be empty');
  }

  const port = raw.DEPLOY_PORT ?? OPTIONAL.DEPLOY_PORT;
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw fail('DEPLOY_PORT', 'must be an integer between 1 and 65535');
  }

  const host = raw.DEPLOY_HOST;
  const ipv4 = IPV4.exec(host);
  if (ipv4 && ipv4.slice(1).some(part => Number(part) > 255)) {
    throw fail('DEPLOY_HOST', 'is not a hostname or a valid IPv4 literal');
  }
  if (!HOST.test(host)) {
    throw fail('DEPLOY_HOST', 'must be a hostname (letters, digits, dot, dash) or an IP literal');
  }

  if (!USER.test(raw.DEPLOY_USER)) {
    throw fail('DEPLOY_USER', 'must be a POSIX user name');
  }

  const path = raw.DEPLOY_PATH;
  if (!ABSPATH.test(path) || path.includes('..') || BADPATH.test(path)) {
    throw fail('DEPLOY_PATH', 'must be an absolute POSIX path without spaces, `..` or metacharacters');
  }

  return {
    DEPLOY_HOST: host,
    DEPLOY_USER: raw.DEPLOY_USER,
    DEPLOY_KEY: raw.DEPLOY_KEY,
    DEPLOY_DOMAIN: raw.DEPLOY_DOMAIN,
    DEPLOY_PATH: path,
    DEPLOY_PORT: port,
    DEPLOY_HOSTKEY: raw.DEPLOY_HOSTKEY ?? OPTIONAL.DEPLOY_HOSTKEY,
  };
}
