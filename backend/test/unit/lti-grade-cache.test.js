// H.3: the in-process caches in front of the Moodle lookups: deadlines, size cap, stale-write guard.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGradeCache, RESULT_TTL_MS, TOKEN_EXPIRY_MARGIN_MS } = require('../../lti/grade-cache');

function cacheWithClock(options = {}) {
  const clock = { ms: 1_000_000 };
  return { clock, cache: createGradeCache({ now: () => clock.ms, ...options }) };
}

test('H_3 a result is remembered, including "not submitted" (null), until its 30 s are up', () => {
  const { clock, cache } = cacheWithClock();
  cache.results.set('a', null, cache.results.begin());
  cache.results.set('b', 0.5, cache.results.begin());

  assert.deepEqual(cache.results.get('a'), { value: null });
  assert.deepEqual(cache.results.get('b'), { value: 0.5 });
  assert.equal(cache.results.get('c'), undefined);

  clock.ms += RESULT_TTL_MS - 1;
  assert.deepEqual(cache.results.get('b'), { value: 0.5 });
  clock.ms += 1;
  assert.equal(cache.results.get('b'), undefined);
});

test('H_3 an invalidation drops the entry and voids lookups that began before it', () => {
  const { cache } = cacheWithClock();
  cache.results.set('k', 0.2, cache.results.begin());
  const early = cache.results.begin();

  cache.results.delete('k');
  cache.results.set('k', null, early); // a slow read finishing late

  assert.equal(cache.results.get('k'), undefined);
  cache.results.set('k', 1, cache.results.begin());
  assert.deepEqual(cache.results.get('k'), { value: 1 });
});

test('H_3 a token lives until its expires_in minus the safety margin; a lifetime inside the margin is not kept', () => {
  const { clock, cache } = cacheWithClock();
  cache.tokens.set('t', 'tok', 3600);
  cache.tokens.set('short', 'tok', TOKEN_EXPIRY_MARGIN_MS / 1000);
  for (const bad of [undefined, NaN, -5, 0]) cache.tokens.set('bad', 'tok', bad);

  assert.equal(cache.tokens.get('t'), 'tok');
  assert.equal(cache.tokens.get('short'), undefined);
  assert.equal(cache.tokens.get('bad'), undefined);

  clock.ms += 3600 * 1000 - TOKEN_EXPIRY_MARGIN_MS - 1;
  assert.equal(cache.tokens.get('t'), 'tok');
  clock.ms += 1;
  assert.equal(cache.tokens.get('t'), undefined);
});

test('H_3 both caches are bounded: past the cap the oldest entry goes first', () => {
  const { cache } = cacheWithClock({ maxEntries: 3 });
  for (const k of ['a', 'b', 'c', 'd']) {
    cache.results.set(k, 1, cache.results.begin());
    cache.tokens.set(k, k, 3600);
  }

  assert.deepEqual(cache.size(), { tokens: 3, results: 3 });
  assert.equal(cache.results.get('a'), undefined);
  assert.equal(cache.tokens.get('a'), undefined);
  assert.equal(cache.results.get('d')?.value, 1);
  assert.equal(cache.tokens.get('d'), 'd');
});

test('H_3 at the cap, expired entries are swept before a live one is evicted', () => {
  const { clock, cache } = cacheWithClock({ maxEntries: 2 });
  cache.results.set('old', 1, cache.results.begin());
  clock.ms += RESULT_TTL_MS - 1;
  cache.results.set('live', 1, cache.results.begin());
  clock.ms += 1; // 'old' has just expired, 'live' has not

  cache.results.set('new', 1, cache.results.begin());

  assert.ok(cache.results.get('live'), 'the live entry survived');
  assert.ok(cache.results.get('new'));
  assert.equal(cache.size().results, 2);
});
