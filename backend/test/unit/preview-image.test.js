// backend/test/unit/preview-image.test.js
//
// Test-plan scenarios 199 (DW-4.2) and 207: `inspectPreview` - type by magic bytes, dimensions
// from the headers, the size, width and aspect rules, and every way a file can be dirty.

const test = require('node:test');
const assert = require('node:assert/strict');

const { inspectPreview } = require('../../preview-image');
const { png, jpeg, padTo, MIB } = require('../helpers/images');

const refused = (buffer, pattern) => assert.throws(() => inspectPreview(buffer), err => {
  assert.equal(err.status, 400);
  if (pattern) assert.match(err.message, pattern);
  return true;
});

test('199. accepts a PNG and a JPEG at 800 px, 16:10, with their size and no warning', () => {
  assert.deepEqual(inspectPreview(png(800, 500)), { type: 'png', ext: 'png', width: 800, height: 500, warnings: [] });
  assert.deepEqual(inspectPreview(jpeg(800, 500)), { type: 'jpeg', ext: 'jpg', width: 800, height: 500, warnings: [] });
});

test('199. a larger 16:10 picture is accepted; 5 MiB exactly is, 5 MiB + 1 byte is not', () => {
  assert.equal(inspectPreview(png(1920, 1200)).width, 1920);
  assert.equal(inspectPreview(padTo(png(800, 500), 5 * MIB)).width, 800);
  refused(padTo(png(800, 500), 5 * MIB + 1), /завелике/);
  refused(padTo(jpeg(800, 500), 5 * MIB + 1), /завелике/);
});

test('199. 16:9 is stored with a warning', () => {
  const wide = inspectPreview(jpeg(1920, 1080));
  assert.equal(wide.warnings.length, 1);
  assert.match(wide.warnings[0], /16:10/);
  assert.equal(inspectPreview(png(1000, 625)).warnings.length, 0, 'exactly 16:10');
});

test('199. the aspect tolerance is 5 %: 4 % off passes, 6 % off warns, in both directions', () => {
  assert.equal(inspectPreview(png(1664, 1000)).warnings.length, 0, '1.664 is 4 % wide');
  assert.equal(inspectPreview(png(1696, 1000)).warnings.length, 1, '1.696 is 6 % wide');
  assert.equal(inspectPreview(png(1664, 1070)).warnings.length, 0, '1.555 is 2.8 % narrow');
  assert.equal(inspectPreview(png(1664, 1100)).warnings.length, 1, '1.513 is 5.5 % narrow');
});

test('199. under 800 px wide -> 400 (799), a tall portrait is a warning only when wide enough', () => {
  refused(png(799, 499), /799/);
  refused(jpeg(799, 499), /799/);
  assert.equal(inspectPreview(png(800, 2000)).warnings.length, 1);
});

test('199. the type is the bytes, not the name: SVG, GIF, text, an empty buffer -> 400', () => {
  refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"></svg>'), /PNG/);
  refused(Buffer.from('GIF89a\x20\x03\xf4\x01', 'latin1'), /PNG/);
  refused(Buffer.from('just some text pretending to be a picture'), /PNG/);
  refused(Buffer.alloc(0), /PNG/);
});

test('199. a file shorter than its header -> 400, at every cut point', () => {
  const full = png(800, 500);
  for (let length = 0; length < 24; length++) refused(full.subarray(0, length));
  const jpg = jpeg(800, 500);
  const sofEnd = jpg.indexOf(Buffer.from('ffc0', 'hex')) + 9;
  for (let length = 0; length < sofEnd; length++) refused(jpg.subarray(0, length));
});

test('199. a PNG whose first chunk is not IHDR, zero or absurd dimensions -> 400', () => {
  const notIhdr = png(800, 500);
  notIhdr.write('JUNK', 12, 'latin1');
  refused(notIhdr);
  refused(png(0, 500));
  refused(png(800, 0));
  refused(jpeg(800, 0));
  refused(png(8193, 5120), /8192/);
  refused(jpeg(800, 65535), /8192/);
});

test('199. a JPEG with no frame header before the scan, or a bogus segment length, -> 400 without looping', () => {
  refused(Buffer.from('ffd8ffe00010', 'hex'));
  refused(Buffer.from('ffd8ffda000c03010002110311003f00', 'hex'));
  refused(Buffer.from('ffd8ffe00001ffd9', 'hex'));
  refused(Buffer.concat([Buffer.from('ffd8', 'hex'), Buffer.alloc(100, 0xff)]));
});

test('199. a JPEG whose frame header comes after other segments (EXIF, comment) is found', () => {
  const frame = jpeg(1600, 1000);
  const comment = Buffer.concat([Buffer.from('fffe', 'hex'), Buffer.from([0x00, 0x07]), Buffer.from('hello')]);
  const withComment = Buffer.concat([frame.subarray(0, 2), comment, frame.subarray(2)]);
  assert.equal(inspectPreview(withComment).width, 1600);
});
