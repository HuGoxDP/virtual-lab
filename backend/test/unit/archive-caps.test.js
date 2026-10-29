// backend/test/unit/archive-caps.test.js
//
// Test-plan scenario 184 (DW-2.6): validation reads at most MAX_ENTRY_BYTES of
// any manifest or scene entry and refuses more than MAX_ARCHIVE_ENTRIES
// entries — a 400, not an out-of-memory.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateScenarioArchive, declaredEntryCount } = require('../../archive-validation');
const { MAX_ENTRY_BYTES, MAX_ARCHIVE_ENTRIES } = require('../../config');
const {
  buildZip, validArchive, sceneJson, writeTemp, removeTemp, VALID_MANIFEST,
} = require('../helpers/fixtures');

const MIB = 1024 * 1024;

async function validate(buffer, limits) {
  const file = await writeTemp(buffer);
  try {
    return await validateScenarioArchive(file, 'catalog-id', limits);
  } finally {
    removeTemp(file);
  }
}

async function rejection(buffer, limits) {
  try {
    await validate(buffer, limits);
  } catch (err) {
    return err;
  }
  return assert.fail('expected the archive to be rejected');
}

/** JSON text of exactly `bytes` bytes: valid, padded with trailing spaces. */
function jsonOfSize(value, bytes) {
  const text = JSON.stringify(value);
  assert.ok(text.length <= bytes);
  return text + ' '.repeat(bytes - text.length);
}

/** An archive with `count` entries in total (manifest, entry point and filler). */
const archiveWithEntries = count => {
  const filler = {};
  for (let i = 0; i < count - 2; i++) filler[`assets/f${i}.txt`] = 'x';
  return buildZip({
    'manifest.json': JSON.stringify(VALID_MANIFEST),
    'scripts/Scenario.js': 'export default class {}',
    ...filler,
  });
};

test('the defaults are 10 MiB and 20 000 unless the environment overrides them', { skip: process.env.MAX_ENTRY_BYTES || process.env.MAX_ARCHIVE_ENTRIES }, () => {
  assert.equal(MAX_ENTRY_BYTES, 10 * MIB);
  assert.equal(MAX_ARCHIVE_ENTRIES, 20_000);
});

test('184. manifest entry cap (DW-2.6)', async t => {
  await t.test('exactly MAX_ENTRY_BYTES is accepted', async () => {
    const buffer = buildZip({
      'manifest.json': jsonOfSize(VALID_MANIFEST, MAX_ENTRY_BYTES),
      'scripts/Scenario.js': 'export default class {}',
    });
    const { manifest } = await validate(buffer);
    assert.equal(manifest.id, VALID_MANIFEST.id);
  });

  await t.test('MAX_ENTRY_BYTES + 1 is a 400 (a ~10 KB download that inflates to 10 MiB)', async () => {
    const buffer = buildZip({
      'manifest.json': jsonOfSize(VALID_MANIFEST, MAX_ENTRY_BYTES + 1),
      'scripts/Scenario.js': 'export default class {}',
    });
    assert.ok(buffer.length < 100 * 1024, 'the fixture really is a high-ratio archive');
    const err = await rejection(buffer);
    assert.equal(err.status, 400);
    assert.match(err.message, /завеликий/);
  });
});

test('184. scene and prefab entry cap (DW-2.6)', async t => {
  const sceneOfSize = bytes => jsonOfSize({ name: 'Main', version: 1, roots: [] }, bytes);

  await t.test('a scene of exactly the cap is read and accepted', async () => {
    await validate(validArchive({}, { 'assets/scenes/main.scene.json': sceneOfSize(MAX_ENTRY_BYTES) }));
  });

  await t.test('a scene one byte over -> 400', async () => {
    const err = await rejection(validArchive({}, { 'assets/scenes/main.scene.json': sceneOfSize(MAX_ENTRY_BYTES + 1) }));
    assert.equal(err.status, 400);
    assert.match(err.message, /main\.scene\.json.*завеликий/);
  });

  await t.test('a prefab one byte over -> 400', async () => {
    const err = await rejection(validArchive({}, { 'assets/prefabs/a.prefab.json': sceneOfSize(MAX_ENTRY_BYTES + 1) }));
    assert.match(err.message, /a\.prefab\.json/);
  });

  await t.test('a large file that is not a manifest or scene is never read', async () => {
    // Textures and models are as large as they like; only what validation reads is capped.
    await validate(validArchive({}, { 'assets/big.bin': Buffer.alloc(MAX_ENTRY_BYTES + 1) }));
  });
});

test('184. entry count cap (DW-2.6)', async t => {
  await t.test('exactly MAX_ARCHIVE_ENTRIES entries is accepted', async () => {
    const { entries } = await validate(archiveWithEntries(MAX_ARCHIVE_ENTRIES));
    assert.equal(entries.length, MAX_ARCHIVE_ENTRIES);
  });

  await t.test('MAX_ARCHIVE_ENTRIES + 1 -> 400', async () => {
    const err = await rejection(archiveWithEntries(MAX_ARCHIVE_ENTRIES + 1));
    assert.equal(err.status, 400);
    assert.match(err.message, /забагато файлів/);
  });

  await t.test('the limits can be overridden per call', async () => {
    assert.match((await rejection(archiveWithEntries(10), { maxEntries: 9 })).message, /забагато/);
    await validate(archiveWithEntries(10), { maxEntries: 10 });
  });
});

test('184. declaredEntryCount reads the count without parsing the directory', async t => {
  const countOf = async buffer => {
    const file = await writeTemp(buffer);
    try {
      return await declaredEntryCount(file);
    } finally {
      removeTemp(file);
    }
  };

  await t.test('the count of a real archive', async () => {
    assert.equal(await countOf(archiveWithEntries(7)), 7);
  });

  await t.test('a bare end record claiming 65 535 entries (zip64 marker) reads as 65 535', async () => {
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0xffff, 10);
    assert.equal(await countOf(end), 0xffff);
  });

  await t.test('the end record is found behind an archive comment', async () => {
    const zip = archiveWithEntries(3);
    zip.writeUInt16LE(5, zip.length - 2);
    assert.equal(await countOf(Buffer.concat([zip, Buffer.from('hello')])), 3);
  });

  await t.test('no end record, and a file shorter than one -> null', async () => {
    assert.equal(await countOf(Buffer.from('not a zip at all, just some bytes')), null);
    assert.equal(await countOf(Buffer.from('tiny')), null);
  });

  await t.test('a hostile count is refused before the parser runs', async () => {
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0xffff, 10);
    const err = await rejection(end);
    assert.match(err.message, /забагато файлів/);
  });
});

test('184. a zip bomb that lies about its size is cut off at the cap (DW-2.6)', async t => {
  const CAP = 1 * MIB;
  const INFLATED = 64 * MIB;

  // Declared size patched to 200 bytes in the local and the central header; the
  // deflate stream still inflates to 64 MiB. Trusting the header would read it all.
  // node-stream-zip itself also fails the read on the size mismatch; what this pins is the
  // outcome (400, bounded memory) whichever of the two stops it first.
  function lyingBomb() {
    const buffer = buildZip({
      'manifest.json': jsonOfSize(VALID_MANIFEST, INFLATED),
      'scripts/Scenario.js': 'export default class {}',
    });
    buffer.writeUInt32LE(200, 22);
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buffer.writeUInt32LE(200, central + 24);
    return buffer;
  }

  const bomb = lyingBomb();
  assert.ok(bomb.length < 256 * 1024, 'the bomb itself is small');

  await t.test('rejected with a 400', async () => {
    const err = await rejection(bomb, { maxEntryBytes: CAP });
    assert.equal(err.status, 400);
  });

  await t.test('without memory growth beyond the cap', async () => {
    let peak = 0;
    const base = process.memoryUsage().arrayBuffers;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); }, 1);
    try {
      await rejection(bomb, { maxEntryBytes: CAP });
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
    assert.ok(peak < 16 * MIB, `buffers grew by ${(peak / MIB).toFixed(1)} MiB against a ${INFLATED / MIB} MiB bomb`);
  });
});

test('a corrupt entry is still reported as unreadable, not as too large', async () => {
  const buffer = validArchive({}, { 'assets/scenes/main.scene.json': sceneJson(1) });
  // Break the deflate stream of the scene file.
  const at = buffer.indexOf(Buffer.from('main.scene.json')) + 'main.scene.json'.length;
  buffer.fill(0xff, at, at + 8);
  const err = await rejection(buffer);
  assert.equal(err.status, 400);
  assert.doesNotMatch(err.message, /завеликий/);
});
