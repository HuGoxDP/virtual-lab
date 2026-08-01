// backend/test/unit/storage.test.js
//
// Covers test-plan scenarios 37, 41, 45 and the integrity half of 46.
// ARCHIVE_ROOT is read at module load, so it is set before the require.

const test = require('node:test');
const assert = require('node:assert/strict');

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-storage-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const storage = require('../../storage');
const { validArchive, invalidArchives } = require('../helpers/fixtures');

test.before(async () => {
  await storage.ensureStorageDirs();
});

test.after(async () => {
  await fsp.rm(ARCHIVE_ROOT, { recursive: true, force: true });
});

async function stageTemp(buffer) {
  return storage.writeTempFromStream(Readable.from([buffer]));
}

async function listObjects() {
  return fsp.readdir(storage.OBJECTS_DIR);
}

async function listTemp() {
  return fsp.readdir(storage.TMP_DIR);
}

test('commitArchive stores content under its own hash', async t => {
  const buffer = validArchive();
  const expected = crypto.createHash('sha256').update(buffer).digest('hex');

  await t.test('the object name equals the content hash', async () => {
    const tmp = await stageTemp(buffer);
    const result = await storage.commitArchive(tmp);

    assert.equal(result.sha256, expected);
    assert.equal(result.bytes, buffer.length);
    assert.equal(result.url, `/scenarios/${expected}.zip`);
    assert.equal(result.deduplicated, false);

    const stored = await fsp.readFile(storage.objectPath(expected));
    assert.equal(
      crypto.createHash('sha256').update(stored).digest('hex'),
      expected,
      'stored bytes must hash back to the filename'
    );
  });

  await t.test('the temp file is consumed by the commit', async () => {
    assert.deepEqual(await listTemp(), []);
  });

  await t.test('identical content deduplicates instead of storing twice', async () => {
    const before = (await listObjects()).length;

    const tmp = await stageTemp(buffer);
    const result = await storage.commitArchive(tmp);

    assert.equal(result.deduplicated, true);
    assert.equal(result.sha256, expected);
    assert.equal((await listObjects()).length, before, 'no second object on disk');
    assert.deepEqual(await listTemp(), [], 'the duplicate temp file is removed');
  });

  await t.test('different content produces a different object', async () => {
    const other = validArchive({ id: 'test.scenario.other' });
    const tmp = await stageTemp(other);
    const result = await storage.commitArchive(tmp);

    assert.notEqual(result.sha256, expected);
    assert.equal(result.deduplicated, false);
    assert.equal((await listObjects()).length, 2);
  });
});

test('commitArchive refuses non-ZIP content', async t => {
  await t.test('rejects with status 400 and leaves nothing behind', async () => {
    const before = (await listObjects()).length;
    const tmp = await stageTemp(invalidArchives.notAZip());

    await assert.rejects(
      () => storage.commitArchive(tmp),
      err => err.status === 400 && /ZIP/.test(err.message)
    );

    assert.equal((await listObjects()).length, before, 'no object was created');
    // The caller owns cleanup on failure; the temp file is still there.
    await storage.discardTemp(tmp);
    assert.deepEqual(await listTemp(), []);
  });
});

test('discardTemp is safe to call twice and on nothing', async () => {
  const tmp = await stageTemp(validArchive({ id: 'discard.me' }));
  await storage.discardTemp(tmp);
  await assert.doesNotReject(() => storage.discardTemp(tmp));
  await assert.doesNotReject(() => storage.discardTemp(undefined));
});

test('cleanStaleTemp respects the age cutoff', async t => {
  await t.test('leaves a fresh file alone', async () => {
    const tmp = await stageTemp(validArchive({ id: 'fresh.upload' }));

    // An in-flight upload must survive a concurrent sweep.
    await storage.cleanStaleTemp(60_000);
    assert.equal((await listTemp()).length, 1);

    await storage.discardTemp(tmp);
  });

  await t.test('removes a file older than the cutoff', async () => {
    const tmp = await stageTemp(validArchive({ id: 'stale.upload' }));

    const past = new Date(Date.now() - 60 * 60 * 1000);
    await fsp.utimes(tmp, past, past);

    await storage.cleanStaleTemp(60_000);
    assert.deepEqual(await listTemp(), []);
  });
});

test('publicUrl and objectPath agree on the hash', () => {
  const hash = 'a'.repeat(64);
  assert.equal(storage.publicUrl(hash), `/scenarios/${hash}.zip`);
  assert.ok(storage.objectPath(hash).endsWith(`${hash}.zip`));
});
