// backend/test/unit/publish-release.test.js
//
// Phase 3 (test-plan scenario 195, DW-3.8): a real run uploads, then approves; existing rows move by transition.
// `publish:release` checks each archive with the upload's own validator before
// it touches the catalog. The server would refuse the upload anyway, but only
// after the script had created or updated the row — leaving a published row with
// no archive, or metadata describing an archive that was never stored. Runs the
// real script against a stand-in API that records every request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { validArchive, sceneJson } = require('../helpers/fixtures');

const run = promisify(execFile);
const SCRIPT = path.join(__dirname, '../../scripts/publish-release.mjs');

/** An API that knows `scenarios` (none by default) and accepts every write, remembering it. */
async function standInApi(scenarios = []) {
  const writes = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/admin/scenarios') {
        return res.end(JSON.stringify({ scenarios }));
      }
      writes.push(`${req.method} ${req.url}`);
      res.statusCode = 201;
      res.end(JSON.stringify({ deduplicated: false, warnings: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { writes, server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function publish(release, baseUrl, extra = []) {
  try {
    const { stdout, stderr } = await run(
      process.execPath, [SCRIPT, '--release', release, '--base-url', baseUrl, ...extra],
      { env: { ...process.env, ADMIN_TOKEN: 'test-token' } }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test('publish:release refuses before it writes', async t => {
  const release = await fsp.mkdtemp(path.join(os.tmpdir(), 'vl-publish-'));
  const api = await standInApi();
  t.after(async () => {
    api.server.close();
    await fsp.rm(release, { recursive: true, force: true });
  });

  // Both ids are production entries in catalog-metadata.mjs.
  await fsp.writeFile(path.join(release, 'Atom.zip'), validArchive({ id: 'atom-structure' }));
  await fsp.writeFile(
    path.join(release, 'Solar.zip'),
    validArchive({ id: 'solar-system' }, { 'assets/scenes/main.scene.json': sceneJson(2) })
  );

  await t.test('a dry run reports the refusal', async () => {
    const { code, stdout, stderr } = await publish(release, api.baseUrl, ['--dry-run']);
    assert.equal(code, 1);
    assert.match(stderr, /Solar\.zip \(solar-system\): the platform would refuse it — .*версії 2/);
    assert.match(stdout, /atom-structure/);
    assert.deepEqual(api.writes, []);
  });

  await t.test('a real run publishes the rest and leaves the refused row untouched', async () => {
    const { code, stderr } = await publish(release, api.baseUrl);
    assert.equal(code, 1);
    assert.match(stderr, /solar-system.*would refuse/);
    // A new row is a draft and approving needs an archive: create, upload, then approve (DW-3.8).
    assert.deepEqual(api.writes, [
      'POST /api/catalog',
      'POST /api/scenarios/atom-structure/archive',
      'POST /api/scenarios/atom-structure/approve',
    ]);
  });
});

test('publish:release moves existing rows with the status transitions (DW-3.8)', async t => {
  const release = await fsp.mkdtemp(path.join(os.tmpdir(), 'vl-publish-'));
  await fsp.mkdir(path.join(release, 'test'));
  const api = await standInApi([
    { id: 'atom-structure', status: 'draft' },
    { id: 'solar-system', status: 'published', isPublished: true },
    { id: 'benchscene1-primitives', status: 'published', isPublished: true },
  ]);
  t.after(async () => {
    api.server.close();
    await fsp.rm(release, { recursive: true, force: true });
  });

  await fsp.writeFile(path.join(release, 'Atom.zip'), validArchive({ id: 'atom-structure' }));
  await fsp.writeFile(path.join(release, 'Solar.zip'), validArchive({ id: 'solar-system' }));
  await fsp.writeFile(path.join(release, 'test', 'B1.zip'), validArchive({ id: 'benchscene1-primitives' }));
  await fsp.writeFile(path.join(release, 'test', 'B2.zip'), validArchive({ id: 'benchscene2-complexmodel' }));

  await t.test('a dry run reports the transitions and writes nothing', async () => {
    const { code, stdout } = await publish(release, api.baseUrl, ['--dry-run']);
    assert.equal(code, 0);
    assert.match(stdout, /atom-structure[\s\S]*would approve/);
    assert.match(stdout, /benchscene1-primitives[\s\S]*would unpublish/);
    assert.deepEqual(api.writes, []);
  });

  await t.test('a real run approves the draft, leaves the live row, unpublishes the bench scene', async () => {
    const { code } = await publish(release, api.baseUrl);
    assert.equal(code, 0);
    const post = api.writes.filter(w => w.startsWith('POST') && !w.endsWith('/archive'));
    assert.deepEqual(post, [
      'POST /api/scenarios/atom-structure/approve',
      'POST /api/scenarios/benchscene1-primitives/unpublish',
      'POST /api/catalog',
    ]);
    // Upload always precedes approve: approving needs a current version.
    assert.ok(api.writes.indexOf('POST /api/scenarios/atom-structure/archive')
      < api.writes.indexOf('POST /api/scenarios/atom-structure/approve'));
  });
});
