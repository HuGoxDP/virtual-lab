// backend/test/unit/player-formats.test.js
//
// The rules themselves, independent of where they are applied. How an upload
// applies them is in archive-validation.test.js; how `import:assets` does is in
// import-release-assets.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCENE_FORMAT_VERSIONS,
  MANIFEST_MAJOR_VERSIONS,
  STREAMING_SCHEMA_VERSIONS,
  isSceneFile,
  sceneFileProblem,
  streamingManifestProblem,
} = require('../../player-formats');

test('what the deployed player reads', async t => {
  // Pinned on purpose: raising any of these lets content through to students
  // that the player in frontend/WebEngineTS-0.1.0.tgz would misread. The header
  // of player-formats.js says when it is safe; this test makes it a decision.
  await t.test('scene and prefab format: version 1 only', () => {
    assert.deepEqual(SCENE_FORMAT_VERSIONS, [1]);
  });

  await t.test('manifest.json: major 1 only', () => {
    assert.deepEqual(MANIFEST_MAJOR_VERSIONS, [1]);
  });

  await t.test('streaming manifest: schema 1 only', () => {
    assert.deepEqual(STREAMING_SCHEMA_VERSIONS, [1]);
  });

  await t.test('the lists cannot be changed at run time', () => {
    assert.ok(Object.isFrozen(SCENE_FORMAT_VERSIONS));
    assert.ok(Object.isFrozen(MANIFEST_MAJOR_VERSIONS));
    assert.ok(Object.isFrozen(STREAMING_SCHEMA_VERSIONS));
  });
});

test('isSceneFile', async t => {
  for (const name of [
    'main.scene.json',
    'assets/scenes/main.scene.json',
    'assets/prefabs/a/b/Door.prefab.json',
    'ASSETS/MAIN.SCENE.JSON',
    'assets/Door.Prefab.Json',
  ]) {
    await t.test(`${name} is one`, () => assert.equal(isSceneFile(name), true));
  }

  for (const name of [
    'assets/scenes/main.scene.json/',
    'assets/scene.json',
    'assets/main.scene.json.bak',
    'assets/main.scenes.json',
    'manifest.json',
    undefined,
  ]) {
    await t.test(`${name} is not`, () => assert.equal(isSceneFile(name), false));
  }
});

test('sceneFileProblem reads bytes the way the player does', async t => {
  await t.test('a Buffer, with a byte-order mark', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"version":1}')]);
    assert.equal(sceneFileProblem('a.scene.json', bytes), null);
  });

  await t.test('a version written as 1.0 is the number 1', () => {
    assert.equal(sceneFileProblem('a.scene.json', '{"version":1.0}'), null);
  });

  await t.test('a version written as 2.0 is the number 2', () => {
    assert.match(sceneFileProblem('a.scene.json', '{"version":2.0}'), /версії 2/);
  });
});

/** A streaming manifest as ScenarioCreator's build-manifest.mjs writes one. */
function streamingManifest(overrides = {}) {
  return {
    schema: 1,
    id: 'demo',
    entry: 'scripts/Scenario.js',
    scripts: [{ path: 'scripts/Scenario.js', url: 'objects/aa/script.js' }],
    assets: [
      { path: 'assets/scenes/main.scene.json', lods: [{ level: 0, url: 'objects/bb/scene.json' }] },
      { path: 'assets/textures/wood.png', lods: [{ level: 0, url: 'objects/cc/wood.png' }] },
    ],
    ...overrides,
  };
}

/** A readObject over a fixed table that records what it was asked for. */
function objects(table) {
  const asked = [];
  const read = async url => {
    asked.push(url);
    return url in table ? Buffer.from(table[url]) : null;
  };
  return { read, asked };
}

test('streamingManifestProblem', async t => {
  await t.test('accepts a manifest whose scenes are version 1, reading only the scenes', async () => {
    const { read, asked } = objects({ 'objects/bb/scene.json': '{"version":1}' });
    assert.equal(await streamingManifestProblem(streamingManifest(), read), null);
    assert.deepEqual(asked, ['objects/bb/scene.json']);
  });

  await t.test('refuses a scene in link mode, naming its path', async () => {
    const { read } = objects({ 'objects/bb/scene.json': '{"version":2}' });
    assert.match(
      await streamingManifestProblem(streamingManifest(), read),
      /сцени "assets\/scenes\/main\.scene\.json" має формат версії 2/
    );
  });

  await t.test('checks every level of a scene, not just the first', async () => {
    const manifest = streamingManifest({
      assets: [{
        path: 'assets/scenes/main.scene.json',
        lods: [{ level: 0, url: 'objects/bb/l0.json' }, { level: 1, url: 'objects/bb/l1.json' }],
      }],
    });
    const { read } = objects({ 'objects/bb/l0.json': '{}', 'objects/bb/l1.json': '{"version":"2"}' });
    assert.match(await streamingManifestProblem(manifest, read), /цілим числом, а не "2"/);
  });

  await t.test('a missing object is left to the caller', async () => {
    const { read } = objects({});
    assert.equal(await streamingManifestProblem(streamingManifest(), read), null);
  });

  for (const [schema, pattern] of [
    [2, /поле schema має значення 2/],
    ['1', /цілим числом, а не "1"/],
    [undefined, /цілим числом, а не null/],
  ]) {
    await t.test(`refuses schema ${JSON.stringify(schema)}`, async () => {
      const { read, asked } = objects({ 'objects/bb/scene.json': '{"version":1}' });
      const message = await streamingManifestProblem(streamingManifest({ schema }), read);
      assert.match(message, /маніфесті "demo"/);
      assert.match(message, pattern);
      assert.deepEqual(asked, [], 'nothing is read for a manifest refused by its schema');
    });
  }
});
