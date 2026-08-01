// backend/test/unit/archive-validation.test.js
//
// Covers test-plan scenarios 39, 40, 41 and the nested-manifest case from §3.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateScenarioArchive } = require('../../archive-validation');
const { validArchive, invalidArchives, writeTemp, removeTemp } = require('../helpers/fixtures');

/** Runs the validator against a buffer and always cleans the temp file up. */
async function validate(buffer, catalogId = 'catalog-id') {
  const file = await writeTemp(buffer);
  try {
    return await validateScenarioArchive(file, catalogId);
  } finally {
    removeTemp(file);
  }
}

async function rejection(buffer, catalogId = 'catalog-id') {
  try {
    await validate(buffer, catalogId);
    assert.fail('expected the archive to be rejected');
  } catch (err) {
    return err;
  }
}

test('accepts a well-formed scenario archive', async t => {
  await t.test('returns the parsed manifest', async () => {
    const { manifest } = await validate(validArchive());
    assert.equal(manifest.id, 'test.scenario.valid');
    assert.equal(manifest.entryPoint, 'Scenario.js');
  });

  await t.test('lists the archive entries', async () => {
    const { entries } = await validate(validArchive());
    assert.ok(entries.includes('manifest.json'));
    assert.ok(entries.includes('scripts/Scenario.js'));
  });
});

test('manifest id mismatch is a warning, never a rejection', async t => {
  // Regression: the original spec required manifest.id === catalog id, which
  // no real archive satisfies — catalogs use slugs, manifests use
  // reverse-domain ids, and the engine never compares the two.
  await t.test('warns when the ids differ but still succeeds', async () => {
    const { manifest, warnings } = await validate(validArchive(), 'solar-system');
    assert.equal(manifest.id, 'test.scenario.valid');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /test\.scenario\.valid/);
    assert.match(warnings[0], /solar-system/);
  });

  await t.test('stays silent when they happen to match', async () => {
    const { warnings } = await validate(validArchive({ id: 'same-id' }), 'same-id');
    assert.deepEqual(warnings, []);
  });

  await t.test('skips the check when no catalog id is supplied', async () => {
    const { warnings } = await validate(validArchive(), '');
    assert.deepEqual(warnings, []);
  });
});

test('rejects malformed archives with a specific reason', async t => {
  await t.test('not a ZIP at all', async () => {
    const err = await rejection(invalidArchives.notAZip());
    assert.equal(err.status, 400);
    assert.match(err.message, /ZIP/);
  });

  await t.test('no manifest.json', async () => {
    const err = await rejection(invalidArchives.noManifest());
    assert.equal(err.status, 400);
    assert.match(err.message, /manifest\.json/);
  });

  await t.test('manifest is not valid JSON', async () => {
    const err = await rejection(invalidArchives.invalidJson());
    assert.equal(err.status, 400);
    assert.match(err.message, /JSON/);
  });

  await t.test('manifest is missing required fields, and names them', async () => {
    const err = await rejection(invalidArchives.missingFields());
    assert.equal(err.status, 400);
    assert.match(err.message, /manifestVersion/);
    assert.match(err.message, /version/);
    assert.match(err.message, /entryPoint/);
  });

  await t.test('entry point declared but absent from the archive', async () => {
    const err = await rejection(invalidArchives.missingEntryPoint());
    assert.equal(err.status, 400);
    assert.match(err.message, /scripts\/Scenario\.js/);
  });

  await t.test('manifest nested in a subdirectory is not accepted', async () => {
    // The engine reads manifest.json from the root; a nested one would make
    // the archive load fail later with a far worse error.
    const err = await rejection(invalidArchives.nestedManifest());
    assert.equal(err.status, 400);
    assert.match(err.message, /manifest\.json/);
  });
});

test('entryPoint paths are normalised', async t => {
  await t.test('a leading slash does not break resolution', async () => {
    const { manifest } = await validate(validArchive({ entryPoint: '/Scenario.js' }));
    assert.equal(manifest.entryPoint, '/Scenario.js');
  });
});
