// backend/trust-proxy.js
//
// The value for Express's `trust proxy` setting, read from TRUST_PROXY. It decides which `X-Forwarded-For`
// entries `req.ip` (and so every rate limiter) may believe: a client can send that header itself, so trusting
// more hops than really sit in front of the API lets it pick its own address and its own rate-limit bucket.
//
//   unset, ""      1   one proxy (nginx, as in docker-compose.yml)
//   "0"            no proxy: the socket address is the client, the header is ignored
//   "2", "3", ...  that many proxies in a row (the LTI demo stand: TLS proxy + nginx)
//   "10.0.0.0/8,loopback"   trust exactly these addresses / subnets / Express keywords as proxies
//
// `true` and `all` are refused: they trust every hop, i.e. whatever the client wrote.

const { isIP } = require('node:net');

const DEFAULT_HOPS = 1;
const MAX_HOPS = 10;
const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** An IP address, optionally with a `/prefix` (Express accepts both). */
function isAddress(entry) {
  const [address, prefix, ...rest] = entry.split('/');
  return rest.length === 0 && isIP(address) !== 0 && (prefix === undefined || /^\d{1,3}$/.test(prefix));
}

/**
 * @param {string|undefined} raw TRUST_PROXY
 * @returns {{ value: number|boolean|string[], warning?: string }} `value` goes to `app.set('trust proxy', value)`
 */
function parseTrustProxy(raw) {
  const text = (raw ?? '').trim();
  if (!text) return { value: DEFAULT_HOPS };

  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops <= MAX_HOPS) return { value: hops === 0 ? false : hops };
    return { value: DEFAULT_HOPS, warning: `TRUST_PROXY=${text} is more than ${MAX_HOPS} hops, using ${DEFAULT_HOPS}` };
  }

  const entries = text.split(',').map(e => e.trim()).filter(Boolean);
  if (entries.length > 0 && entries.every(e => KEYWORDS.has(e) || isAddress(e))) return { value: entries };
  return { value: DEFAULT_HOPS, warning: `TRUST_PROXY="${text}" is not a hop count or a list of addresses, using ${DEFAULT_HOPS}` };
}

module.exports = { parseTrustProxy, DEFAULT_HOPS };
