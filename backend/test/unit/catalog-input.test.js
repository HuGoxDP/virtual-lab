// backend/test/unit/catalog-input.test.js
//
// Covers test-plan scenario 111: the pure helpers behind the Nocturne catalog API.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateFeatures } = require('../../catalog-input');
const { parseSort, parseMaxArchiveBytes } = require('../../server');

test('111. validateFeatures', async t => {
  await t.test('returns a cleaned copy for a valid list', () => {
    const input = [{ icon: 'atom', title: ' A ', subtitle: 'b', extra: 1 }];
    assert.deepEqual(validateFeatures(input), { value: [{ icon: 'atom', title: 'A', subtitle: 'b' }] });
    assert.equal(input[0].title, ' A ', 'input is not mutated');
  });

  await t.test('treats a null subtitle as absent', () => {
    assert.deepEqual(validateFeatures([{ icon: 'a', title: 'T', subtitle: null }]), { value: [{ icon: 'a', title: 'T' }] });
  });

  await t.test('rejects non-arrays and bad items with a message', () => {
    for (const bad of [undefined, null, 'x', {}, [null], [{ icon: 'A', title: 'T' }], [{ icon: 'a' }]]) {
      assert.equal(typeof validateFeatures(bad).error, 'string', JSON.stringify(bad));
    }
  });
});

test('111. parseSort', async t => {
  await t.test('accepts the two known keys', () => {
    assert.equal(parseSort('new'), 'new');
    assert.equal(parseSort('title'), 'title');
  });

  await t.test('everything else is new, including prototype keys', () => {
    for (const bad of [undefined, '', 'DROP', 'Title', ['title'], { a: 1 }, 'constructor', '__proto__', 'toString']) {
      assert.equal(parseSort(bad), 'new');
    }
  });
});

test('111. parseMaxArchiveBytes', async t => {
  await t.test('defaults to 200 MiB', () => {
    assert.equal(parseMaxArchiveBytes(undefined), 209715200);
    assert.equal(parseMaxArchiveBytes(''), 209715200);
  });

  await t.test('accepts a positive integer string', () => {
    assert.equal(parseMaxArchiveBytes('1048576'), 1048576);
  });

  await t.test('rejects junk', () => {
    for (const bad of ['abc', '0', '-1', '1.5', 'Infinity']) {
      assert.equal(parseMaxArchiveBytes(bad), 209715200, bad);
    }
  });
});
