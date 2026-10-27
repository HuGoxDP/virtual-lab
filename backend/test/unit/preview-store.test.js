// backend/test/unit/preview-store.test.js
//
// Test-plan scenarios 200 (DW-4.2) and 207: the second content-addressed store. `commitPreview`
// names an object by the hash of its bytes, deduplicates and refreshes age; the store lists only
// names it wrote; classification and deletion treat it exactly like the archive store; the two
// stores never see each other's files. ARCHIVE_ROOT and PREVIEW_ROOT are read at load.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const base = path.join(os.tmpdir(), `vl-previews-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = path.join(base, 'archives');
process.env.PREVIEW_ROOT = path.join(base, 'previews');

const storage = require('../../storage');
const { png, jpeg } = require('../helpers/images');

const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const HOUR = 60 * 60 * 1000;

test.before(() => storage.ensureStorageDirs());
test.after(() => fsp.rm(base, { recursive: true, force: true }));

test('200. DW-4.2 ensureStorageDirs creates both stores, each with its own tmp dir on its own volume', async () => {
  for (const dir of [storage.archives.objectsDir, storage.archives.tmpDir, storage.previews.objectsDir, storage.previews.tmpDir]) {
    assert.ok((await fsp.stat(dir)).isDirectory(), dir);
  }
  assert.equal(path.dirname(storage.previews.tmpDir), storage.PREVIEW_ROOT);
  assert.notEqual(storage.previews.tmpDir, storage.archives.tmpDir);
});

test('200. DW-4.2 commitPreview stores PNG and JPEG as <sha256>.<ext> and returns the public /previews/ URL', async () => {
  for (const [buffer, ext] of [[png(800, 500), 'png'], [jpeg(1600, 1000), 'jpg']]) {
    const stored = await storage.commitPreview(buffer, ext);
    assert.equal(stored.sha256, sha(buffer));
    assert.equal(stored.bytes, buffer.length);
    assert.equal(stored.url, `/previews/${sha(buffer)}.${ext}`);
    assert.equal(stored.deduplicated, false);
    assert.deepEqual(await fsp.readFile(path.join(storage.previews.objectsDir, `${sha(buffer)}.${ext}`)), buffer);
  }
  assert.deepEqual(await fsp.readdir(storage.previews.tmpDir), [], 'no temp file left');
});

test('200. DW-4.2 the same bytes twice are one object; the second commit refreshes its age', async () => {
  const buffer = png(900, 562);
  const first = await storage.commitPreview(buffer, 'png');
  const file = path.join(storage.previews.objectsDir, `${first.sha256}.png`);
  const old = new Date(Date.now() - 5 * HOUR);
  await fsp.utimes(file, old, old);

  const second = await storage.commitPreview(buffer, 'png');
  assert.equal(second.deduplicated, true);
  assert.ok((await fsp.stat(file)).mtimeMs > Date.now() - HOUR, 'touched, so GC will not sweep it from under a row');
  assert.deepEqual(await fsp.readdir(storage.previews.tmpDir), []);
});

test('200. DW-4.2 previewHashOf reads only the URLs this store issues', () => {
  const hash = 'b'.repeat(64);
  assert.equal(storage.previewHashOf(`/previews/${hash}.png`), hash);
  assert.equal(storage.previewHashOf(`/previews/${hash}.jpg`), hash);
  for (const other of ['', '/assets/x.jpg', `/previews/${hash}.gif`, `/previews/${hash}.png.exe`, `x/previews/${hash}.png`, null, undefined, 5]) {
    assert.equal(storage.previewHashOf(other), null, String(other));
  }
});

test('200. DW-4.2 listing, classifying and deleting: referenced kept, orphans collectible, young ones protected', async () => {
  const kept = await storage.commitPreview(png(1000, 625), 'png');
  const orphan = await storage.commitPreview(jpeg(1000, 625), 'jpg');
  const young = await storage.commitPreview(png(1100, 688), 'png');
  const old = new Date(Date.now() - 5 * HOUR);
  for (const object of [kept, orphan]) await fsp.utimes(path.join(storage.previews.objectsDir, `${object.sha256}.${object === orphan ? 'jpg' : 'png'}`), old, old);
  // Not ours: must never be listed, so GC can never delete it.
  await fsp.writeFile(path.join(storage.previews.objectsDir, 'readme.txt'), 'hands off');
  await fsp.writeFile(path.join(storage.previews.objectsDir, `${'c'.repeat(64)}.gif`), 'gif');

  const listed = await storage.previews.listObjects();
  assert.ok(listed.every(o => /^[0-9a-f]{64}\.(png|jpg)$/.test(o.name)));

  const { referenced, orphans, tooNew } = await storage.previews.classifyObjects(new Set([kept.sha256]), HOUR);
  assert.ok(referenced.some(o => o.sha256 === kept.sha256));
  assert.deepEqual(orphans.map(o => o.sha256), [orphan.sha256]);
  assert.ok(tooNew.some(o => o.sha256 === young.sha256));

  const deleted = await storage.previews.deleteObjects(orphans);
  assert.deepEqual(deleted.map(o => o.sha256), [orphan.sha256]);
  const left = await fsp.readdir(storage.previews.objectsDir);
  assert.ok(!left.includes(`${orphan.sha256}.jpg`));
  assert.ok(left.includes('readme.txt'));
  assert.ok(left.includes(`${kept.sha256}.png`));
  // Deleting what is already gone is not an error and reports nothing.
  assert.deepEqual(await storage.previews.deleteObjects(orphans), []);
});

test('200. DW-4.2 the archive store is unchanged: .zip names only, and it never lists a preview', async () => {
  const zipName = `${'d'.repeat(64)}.zip`;
  await fsp.writeFile(path.join(storage.archives.objectsDir, zipName), 'PK');
  await fsp.writeFile(path.join(storage.archives.objectsDir, `${'e'.repeat(64)}.png`), 'not an archive');

  assert.deepEqual((await storage.listObjects()).map(o => o.name), [zipName]);
  assert.equal(storage.objectPath('d'.repeat(64)), path.join(storage.archives.objectsDir, zipName));
  assert.equal(storage.publicUrl('d'.repeat(64)), `/scenarios/${zipName}`);

  // The legacy shape (no `name`) still deletes by hash.
  assert.equal((await storage.deleteObjects([{ sha256: 'd'.repeat(64) }])).length, 1);
});

test('200. DW-4.2 cleanStaleTemp sweeps both tmp dirs, keeping fresh files', async () => {
  const stale = [path.join(storage.archives.tmpDir, 'old.part'), path.join(storage.previews.tmpDir, 'old.part')];
  const fresh = [path.join(storage.archives.tmpDir, 'new.part'), path.join(storage.previews.tmpDir, 'new.part')];
  for (const file of [...stale, ...fresh]) await fsp.writeFile(file, 'x');
  const long = new Date(Date.now() - 24 * HOUR);
  for (const file of stale) await fsp.utimes(file, long, long);

  await storage.cleanStaleTemp();

  for (const file of stale) await assert.rejects(fsp.stat(file));
  for (const file of fresh) assert.ok((await fsp.stat(file)).isFile());
});
