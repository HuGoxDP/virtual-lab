// backend/test/unit/import-release-assets.test.js
//
// `import:assets` must refuse what the student player cannot read, as an upload
// does, and must stage nothing of a refused manifest. Runs the real script with
// `--stage-only`, so no Docker and no API are involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const SCRIPT = path.join(__dirname, '../../scripts/import-release-assets.mjs');

/** Writes one content-addressed object into the release and returns its manifest url. */
async function putObject(release, contents, ext) {
  const sha = crypto.createHash('sha256').update(contents).digest('hex');
  const url = `objects/${sha.slice(0, 2)}/${sha}.${ext}`;
  await fsp.mkdir(path.join(release, path.dirname(url)), { recursive: true });
  await fsp.writeFile(path.join(release, url), contents);
  return url;
}

/** A runnable streaming manifest with one scene, as build-manifest.mjs writes it. */
async function putScenario(release, id, { scene, schema = 1 }) {
  const script = await putObject(release, `export default class ${id.replace(/\W/g, '')} {}`, 'js');
  const sceneUrl = await putObject(release, scene, 'json');
  const manifest = {
    schema,
    id,
    entry: 'scripts/Scenario.js',
    scripts: [{ path: 'scripts/Scenario.js', url: script }],
    assets: [{ path: 'assets/scenes/main.scene.json', lods: [{ level: 0, url: sceneUrl }] }],
  };
  await fsp.writeFile(path.join(release, `${id}.scenario.json`), JSON.stringify(manifest));
  return { script, sceneUrl };
}

/** Runs the import; resolves with the exit code and output whether it succeeded or not. */
async function importRelease(release, out) {
  try {
    const { stdout, stderr } = await run(
      process.execPath, [SCRIPT, '--release', release, '--out', out, '--stage-only'],
      { env: { ...process.env, ADMIN_TOKEN: '' } }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

const exists = file => fsp.access(file).then(() => true, () => false);

test('import:assets applies the player formats', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vl-import-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const release = path.join(root, 'release');
  const out = path.join(root, 'staged');
  await fsp.mkdir(release);

  const good = await putScenario(release, 'plain', { scene: JSON.stringify({ version: 1, roots: [] }) });
  const linked = await putScenario(release, 'linked', { scene: JSON.stringify({ version: 2, roots: [] }) });
  await putScenario(release, 'newer', { scene: '{}', schema: 2 });

  const result = await importRelease(release, out);

  await t.test('imports what the player reads', async () => {
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await exists(path.join(out, 'plain.json')));
    assert.ok(await exists(path.join(out, good.sceneUrl)));
    assert.ok(await exists(path.join(out, good.script)));
  });

  await t.test('refuses a link-mode scene, naming the scenario and the file', () => {
    assert.match(result.stderr, /linked: refused.*"assets\/scenes\/main\.scene\.json" має формат версії 2/);
  });

  await t.test('refuses an unknown streaming schema', () => {
    assert.match(result.stderr, /newer: refused.*поле schema має значення 2/);
  });

  await t.test('stages nothing of a refused manifest', async () => {
    assert.equal(await exists(path.join(out, 'linked.json')), false);
    assert.equal(await exists(path.join(out, 'newer.json')), false);
    assert.equal(await exists(path.join(out, linked.sceneUrl)), false);
    assert.equal(await exists(path.join(out, linked.script)), false);
  });

  await t.test('fails outright when everything is refused', async () => {
    const only = path.join(root, 'only-linked');
    await fsp.mkdir(only);
    await putScenario(only, 'linked', { scene: JSON.stringify({ version: 2 }) });

    const { code, stderr } = await importRelease(only, path.join(root, 'staged-2'));
    assert.equal(code, 1);
    assert.match(stderr, /Nothing imported/);
  });
});
