// backend/test/unit/archive-validation.test.js
//
// Covers test-plan scenarios 39, 40, 41 and the nested-manifest case from §3.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateScenarioArchive } = require('../../archive-validation');
const {
  validArchive, sceneJson, invalidArchives, writeTemp, removeTemp,
} = require('../helpers/fixtures');

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

// ══════════════════════════════════════════════════════
// WHAT THE STUDENT PLAYER CAN READ (player-formats.js)
// ══════════════════════════════════════════════════════

/** An otherwise valid archive carrying these extra files. */
const withFiles = files => validArchive({}, files);

test('scene and prefab files the player reads are accepted', async t => {
  await t.test('explicit version 1', async () => {
    const { entries } = await validate(withFiles({ 'assets/scenes/main.scene.json': sceneJson(1) }));
    assert.ok(entries.includes('assets/scenes/main.scene.json'));
  });

  await t.test('absent version means 1', async () => {
    await validate(withFiles({ 'assets/scenes/main.scene.json': sceneJson(undefined) }));
  });

  await t.test('a prefab, nested deep', async () => {
    await validate(withFiles({
      'assets/prefabs/doors/wooden/Door.prefab.json': JSON.stringify({ version: 1, snapshot: {} }),
    }));
  });

  await t.test('uppercase extension, version 1', async () => {
    await validate(withFiles({ 'assets/Scenes/MAIN.SCENE.JSON': sceneJson(1) }));
  });

  await t.test('a UTF-8 byte-order mark, which the player drops too', async () => {
    await validate(withFiles({ 'assets/scenes/main.scene.json': `\uFEFF${sceneJson(1)}` }));
  });

  await t.test('a directory whose name looks like a scene is not read', async () => {
    await validate(withFiles({ 'assets/odd.scene.json/': '' }));
  });

  await t.test('other JSON is not a scene, whatever its version', async () => {
    await validate(withFiles({
      'assets/data/table.json': JSON.stringify({ version: 2 }),
      'assets/scenes/main.scene.json.bak': JSON.stringify({ version: 2 }),
      'assets/scene.json': JSON.stringify({ version: 2 }),
    }));
  });
});

test('scene and prefab files the player cannot read are refused, by name', async t => {
  const refused = async files => {
    const err = await rejection(withFiles(files));
    assert.equal(err.status, 400);
    return err.message;
  };

  await t.test('version 2 (link mode), naming the file, the version and what the player reads', async () => {
    const message = await refused({ 'assets/scenes/main.scene.json': sceneJson(2) });
    assert.match(message, /сцени "assets\/scenes\/main\.scene\.json"/);
    assert.match(message, /версії 2/);
    assert.match(message, /лише версію 1/);
  });

  await t.test('version 3', async () => {
    assert.match(await refused({ 'assets/scenes/main.scene.json': sceneJson(3) }), /версії 3/);
  });

  await t.test('a prefab is named as one', async () => {
    const message = await refused({
      'assets/prefabs/Door.prefab.json': JSON.stringify({ version: 2, snapshot: {} }),
    });
    assert.match(message, /префаба "assets\/prefabs\/Door\.prefab\.json"/);
  });

  await t.test('uppercase extension is still a scene', async () => {
    assert.match(await refused({ 'ASSETS/MAIN.SCENE.JSON': sceneJson(2) }), /MAIN\.SCENE\.JSON/);
  });

  await t.test('found in any directory, scripts/ included', async () => {
    assert.match(await refused({ 'scripts/data/level.scene.json': sceneJson(2) }), /level\.scene\.json/);
  });

  for (const [label, version, shown] of [
    ['a string "2"', '2', /не "2"/],
    ['null', null, /не null/],
    ['1.5', 1.5, /не 1\.5/],
  ]) {
    await t.test(`version ${label} is not an integer`, async () => {
      const message = await refused({ 'assets/scenes/main.scene.json': sceneJson(version) });
      assert.match(message, /main\.scene\.json/);
      assert.match(message, /цілим числом/);
      assert.match(message, shown);
      assert.match(message, /лише версію 1/);
    });
  }

  for (const version of [0, -1]) {
    await t.test(`version ${version} is an integer the player does not read`, async () => {
      const message = await refused({ 'assets/scenes/main.scene.json': sceneJson(version) });
      assert.match(message, new RegExp(`версії ${version},`));
    });
  }

  await t.test('invalid JSON', async () => {
    const message = await refused({ 'assets/scenes/main.scene.json': '{ "version": 1, ' });
    assert.match(message, /"assets\/scenes\/main\.scene\.json" не є валідним JSON/);
  });

  await t.test('JSON that is not an object', async () => {
    assert.match(await refused({ 'assets/scenes/main.scene.json': '[1]' }), /JSON-об'єкт/);
  });

  await t.test('one bad file among good ones is enough', async () => {
    const message = await refused({
      'assets/scenes/a.scene.json': sceneJson(1),
      'assets/scenes/b.scene.json': sceneJson(2),
      'assets/scenes/c.scene.json': sceneJson(undefined),
    });
    assert.match(message, /b\.scene\.json/);
  });
});

test('manifestVersion: a major the player reads', async t => {
  // Every producer writes "1.0" (ScenarioCreator's build-package.mjs, the engine's
  // SCENARIO_MANIFEST_VERSION); the engine only checks the field is present, so the
  // other forms here are ones an existing archive could carry and has always loaded.
  for (const value of ['1.0', '1', '1.2', '1.0.0', 1]) {
    await t.test(`accepts ${JSON.stringify(value)}`, async () => {
      await validate(validArchive({ manifestVersion: value }));
    });
  }

  for (const [value, pattern] of [
    ['2.0', /manifestVersion "2\.0".*лише версію 1\.x/],
    ['0.9', /manifestVersion "0\.9"/],
    [2, /manifestVersion 2,/],
    ['v1', /на зразок "1\.0", а не "v1"/],
    [true, /а не true/],
  ]) {
    await t.test(`refuses ${JSON.stringify(value)}`, async () => {
      const err = await rejection(validArchive({ manifestVersion: value }));
      assert.equal(err.status, 400);
      assert.match(err.message, pattern);
    });
  }

  await t.test('the fixtures used by the integration tests are refused for the stated reason', async () => {
    assert.match((await rejection(invalidArchives.unknownManifestMajor())).message, /manifestVersion "2\.0"/);
    assert.match((await rejection(invalidArchives.sceneVersion2())).message, /версії 2/);
  });
});
