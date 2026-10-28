// H.2: TRUST_PROXY parsing. The value decides whose X-Forwarded-For a rate limiter believes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTrustProxy } = require('../../trust-proxy');

test('H_2 unset or blank trusts one proxy, matching the production compose (nginx)', () => {
  assert.deepEqual(parseTrustProxy(undefined), { value: 1 });
  assert.deepEqual(parseTrustProxy(''), { value: 1 });
  assert.deepEqual(parseTrustProxy('  '), { value: 1 });
});

test('H_2 a hop count is passed through, and 0 means no proxy at all', () => {
  assert.deepEqual(parseTrustProxy('2'), { value: 2 });
  assert.deepEqual(parseTrustProxy('0'), { value: false });
});

test('H_2 a list of addresses, subnets and Express keywords is trusted as given', () => {
  assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8,fd00::/8'), { value: ['loopback', '10.0.0.0/8', 'fd00::/8'] });
});

test('H_2 values that would trust every hop, or that make no sense, fall back to one hop with a warning', () => {
  for (const raw of ['true', 'all', 'yes', '-1', '11', '1.5', 'bogus,10.0.0.1', ',', '10.0.0.1; drop']) {
    const { value, warning } = parseTrustProxy(raw);
    assert.equal(value, 1, raw);
    assert.match(warning, /TRUST_PROXY/, raw);
  }
});
