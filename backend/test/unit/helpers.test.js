// backend/test/unit/helpers.test.js
//
// Pure helpers, no I/O. Covers test-plan scenarios 7, 10, 21, 35.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeLikePattern,
  tokensMatch,
  toGoogleDriveDirectUrl,
  parseLimit,
  parseOffset,
} = require('../../server');

test('escapeLikePattern neutralises ILIKE wildcards', async t => {
  await t.test('escapes percent, underscore and backslash', () => {
    assert.equal(escapeLikePattern('%'), '\\%');
    assert.equal(escapeLikePattern('_'), '\\_');
    assert.equal(escapeLikePattern('\\'), '\\\\');
  });

  await t.test('leaves ordinary text alone', () => {
    assert.equal(escapeLikePattern('Сонячна Система'), 'Сонячна Система');
    assert.equal(escapeLikePattern(''), '');
  });

  await t.test('escapes every occurrence, not just the first', () => {
    assert.equal(escapeLikePattern('a%b%c'), 'a\\%b\\%c');
    assert.equal(escapeLikePattern('__'), '\\_\\_');
  });

  await t.test('a query of only wildcards cannot match everything', () => {
    // Regression for the defect where ?q=% returned the entire catalog.
    assert.equal(escapeLikePattern('%%%'), '\\%\\%\\%');
  });
});

test('tokensMatch is length-guarded and value-correct', async t => {
  await t.test('accepts an identical token', () => {
    assert.equal(tokensMatch('abc123', 'abc123'), true);
  });

  await t.test('rejects a different token of equal length', () => {
    assert.equal(tokensMatch('abc123', 'abc124'), false);
  });

  await t.test('rejects a different length without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the guard must catch it.
    assert.doesNotThrow(() => tokensMatch('short', 'much-longer-token'));
    assert.equal(tokensMatch('short', 'much-longer-token'), false);
    assert.equal(tokensMatch('', 'x'), false);
  });

  await t.test('rejects a prefix of the real token', () => {
    assert.equal(tokensMatch('abc', 'abc123'), false);
  });
});

test('parseLimit clamps and defaults', async t => {
  await t.test('honours a sane value', () => {
    assert.equal(parseLimit('10'), 10);
  });

  await t.test('caps at 100', () => {
    assert.equal(parseLimit('5000'), 100);
    assert.equal(parseLimit('101'), 100);
  });

  await t.test('falls back to 24 for junk, zero and negatives', () => {
    for (const input of ['0', '-1', 'abc', '', undefined, null, {}]) {
      assert.equal(parseLimit(input), 24, `input: ${JSON.stringify(input)}`);
    }
  });
});

test('parseOffset defaults to zero', async t => {
  await t.test('honours a positive value', () => {
    assert.equal(parseOffset('40'), 40);
  });

  await t.test('rejects negatives and junk', () => {
    for (const input of ['-5', 'abc', '', undefined, null]) {
      assert.equal(parseOffset(input), 0, `input: ${JSON.stringify(input)}`);
    }
  });
});

test('toGoogleDriveDirectUrl rewrites sharing links', async t => {
  await t.test('converts the /file/d/ form', () => {
    assert.equal(
      toGoogleDriveDirectUrl('https://drive.google.com/file/d/ABC_123-x/view?usp=sharing'),
      'https://drive.google.com/uc?export=download&id=ABC_123-x'
    );
  });

  await t.test('converts the ?id= form', () => {
    assert.equal(
      toGoogleDriveDirectUrl('https://drive.google.com/open?id=ABC_123-x'),
      'https://drive.google.com/uc?export=download&id=ABC_123-x'
    );
  });

  await t.test('passes a non-Drive URL through unchanged', () => {
    const url = 'https://storage.googleapis.com/bucket/object.zip';
    assert.equal(toGoogleDriveDirectUrl(url), url);
  });
});
