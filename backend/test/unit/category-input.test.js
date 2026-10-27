// backend/test/unit/category-input.test.js
//
// Test-plan scenarios 198 (DW-4.1), 201 (DW-4.2/4.6) and 207: `validateCategory` (slug rule
// at 1/2/50/51 characters and uppercase) and `imageUrlProblem` (what a moderator may put in
// `imageUrl` through a PUT/POST).

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateCategory, imageUrlProblem, CATEGORY_SLUG_PATTERN } = require('../../catalog-input');

const create = body => validateCategory(body, { create: true });
const update = body => validateCategory(body, { create: false });

test('198. DW-4.1 slug: 2-50 characters of a-z, 0-9 and hyphen; 1, 51, uppercase, underscore, space, Cyrillic are refused', () => {
  for (const ok of ['ab', 'a-', '-a', '0-9', 'a'.repeat(50)]) assert.ok(create({ slug: ok, label: 'L' }).value, ok);
  for (const bad of ['a', '', 'a'.repeat(51), 'Physics', 'phy_sics', 'phy sics', 'фізика', 'a/b', undefined, null, 5, ['ab']]) {
    assert.equal(typeof create({ slug: bad, label: 'L' }).error, 'string', String(bad));
  }
  assert.ok(CATEGORY_SLUG_PATTERN.test('physics'));
});

test('198. DW-4.1 create: label trimmed, 1-100 characters; icon defaults to folder; unknown keys dropped', () => {
  assert.deepEqual(create({ slug: 'chem', label: '  Хімія ', extra: 1 }), { value: { slug: 'chem', label: 'Хімія', icon: 'folder' } });
  assert.deepEqual(create({ slug: 'chem', label: 'X', icon: 'flask', isVisible: false }).value,
    { slug: 'chem', label: 'X', icon: 'flask', isVisible: false });
  assert.ok(create({ slug: 'chem', label: 'l'.repeat(100) }).value);
  for (const bad of [undefined, '', '   ', 'l'.repeat(101), 5, null]) assert.ok(create({ slug: 'chem', label: bad }).error, String(bad));
  for (const bad of ['Flask', 'a b', '', 'i'.repeat(41), 5]) assert.ok(create({ slug: 'chem', label: 'X', icon: bad }).error, String(bad));
  for (const bad of ['yes', 1, null]) assert.ok(create({ slug: 'chem', label: 'X', isVisible: bad }).error, String(bad));
});

test('198. DW-4.1 update: any of label, icon, isVisible; the slug cannot be sent; an empty body is an error', () => {
  assert.deepEqual(update({ isVisible: false }), { value: { isVisible: false } });
  assert.deepEqual(update({ label: ' New ', icon: 'dna' }), { value: { label: 'New', icon: 'dna' } });
  assert.deepEqual(update({ slug: 'renamed', label: 'L' }), { value: { label: 'L' } });
  for (const bad of [{}, { slug: 'x' }, undefined, null, 'x', []]) assert.ok(update(bad).error, JSON.stringify(bad));
  assert.ok(update({ label: '' }).error);
});

test('201. DW-4.6 imageUrl: empty, the current value and a stored preview path are allowed; everything else is not', () => {
  const hash = 'a'.repeat(64);
  assert.equal(imageUrlProblem('', '/assets/x.jpg'), null);
  assert.equal(imageUrlProblem('/assets/x.jpg', '/assets/x.jpg'), null);
  assert.equal(imageUrlProblem(`/previews/${hash}.png`, ''), null);
  assert.equal(imageUrlProblem(`/previews/${hash}.jpg`, ''), null);
  // The current value stays allowed even when it is odd: the old admin form resends it on every save.
  assert.equal(imageUrlProblem('https://old.example/x.png', 'https://old.example/x.png'), null);

  for (const bad of [
    'https://images.unsplash.com/photo.jpg', 'http://x/y.png', '//evil.example/x.png', '/assets/other.jpg',
    '/previews/short.png', `/previews/${hash}.gif`, `/previews/${hash}.png?x=1`, `/previews/../${hash}.png`,
    `/previews/${hash.toUpperCase()}.png`, 'data:image/png;base64,AAAA', 'javascript:alert(1)',
  ]) {
    assert.equal(typeof imageUrlProblem(bad, '/assets/x.jpg'), 'string', bad);
  }
  for (const nonString of [null, 5, {}, ['/previews/x']]) assert.match(imageUrlProblem(nonString, ''), /рядком/);
});
