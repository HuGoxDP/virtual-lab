// backend/test/unit/publish-release.test.js
//
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

/** An API that knows no scenarios and accepts every write, remembering it. */
async function standInApi() {
  const writes = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/admin/scenarios') {
        return res.end(JSON.stringify({ scenarios: [] }));
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
    assert.deepEqual(api.writes, ['POST /api/catalog', 'POST /api/scenarios/atom-structure/archive']);
  });
});
