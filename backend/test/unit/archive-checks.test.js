// backend/test/unit/archive-checks.test.js
//
// Test-plan scenarios 202 (DW-4.3) and 207: the static checks (`checksFromValidation`,
// `runArchiveChecks`), the contents listing (`listArchiveEntries`) and the manifest field
// limits the validator now enforces so no accepted archive can make an INSERT fail.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateScenarioArchive, listArchiveEntries } = require('../../archive-validation');
const { checksFromValidation, failedChecks, runArchiveChecks } = require('../../archive-checks');
const { buildZip, validArchive, invalidArchives, writeTemp, removeTemp, VALID_MANIFEST } = require('../helpers/fixtures');

async function withFile(buffer, work) {
  const file = await writeTemp(buffer);
  try {
    return await work(file);
  } finally {
    removeTemp(file);
  }
}

const levels = checks => checks.items.map(item => item.level);

test('202. DW-4.3 a clean archive: ok, with manifest and files lines and no warning', async () => {
  const buffer = validArchive({ id: 'catalog-id', engineVersion: '0.1.0-local.1' });
  const checks = await withFile(buffer, file => runArchiveChecks(file, 'catalog-id', buffer.length));
  assert.equal(checks.ok, true);
  assert.deepEqual(levels(checks), ['ok', 'ok', 'ok']);
  for (const item of checks.items) {
    assert.equal(typeof item.label, 'string');
    assert.equal(typeof item.note, 'string');
  }
  assert.match(checks.items[0].note, /catalog-id/);
  assert.match(checks.items[1].note, new RegExp(String(buffer.length)));
});

test('202. DW-4.3 a catalog-id mismatch and a missing engine version are warnings, the archive stays ok', async () => {
  const buffer = validArchive();
  const checks = await withFile(buffer, file => runArchiveChecks(file, 'other-id', buffer.length));
  assert.equal(checks.ok, true);
  assert.deepEqual(levels(checks).sort(), ['ok', 'ok', 'warning', 'warning']);
});

test('202. DW-4.3 an archive the validator refuses is one error item carrying its message, not an exception', async () => {
  for (const [name, make] of Object.entries(invalidArchives)) {
    const buffer = make();
    const checks = await withFile(buffer, file => runArchiveChecks(file, 'id', buffer.length));
    assert.equal(checks.ok, false, name);
    assert.deepEqual(levels(checks), ['error'], name);
    assert.ok(checks.items[0].note.length > 0, name);
  }
});

test('202. DW-4.3 checksFromValidation and a re-run agree: the stored result at upload is the re-run result', async () => {
  const buffer = validArchive({ id: 'same' });
  const viaRun = await withFile(buffer, file => runArchiveChecks(file, 'same', buffer.length));
  const validated = await withFile(buffer, file => validateScenarioArchive(file, 'same'));
  assert.deepEqual(checksFromValidation(validated, buffer.length), viaRun);
});

test('202. DW-4.3 an unreadable path is an error item too (the object vanished from the store)', async () => {
  const checks = await runArchiveChecks('/no/such/file.zip', 'id', 0);
  assert.equal(checks.ok, false);
  assert.deepEqual(checks, failedChecks(checks.items[0].note));
});

test('202. DW-4.3 contents: files and directories with unpacked sizes, sorted, nested paths intact', async () => {
  const buffer = buildZip({
    'manifest.json': JSON.stringify(VALID_MANIFEST),
    'scripts/Scenario.js': 'export default class {}',
    'assets/': '',
    'assets/deep/nested/model.glb': 'x'.repeat(1234),
    'assets/readme.txt': 'asset',
  });
  const entries = await withFile(buffer, file => listArchiveEntries(file));
  assert.deepEqual(entries.map(e => e.path), [
    'assets/', 'assets/deep/nested/model.glb', 'assets/readme.txt', 'manifest.json', 'scripts/Scenario.js',
  ]);
  const byPath = Object.fromEntries(entries.map(e => [e.path, e]));
  assert.deepEqual(byPath['assets/'], { path: 'assets/', bytes: 0, dir: true });
  assert.deepEqual(byPath['assets/deep/nested/model.glb'], { path: 'assets/deep/nested/model.glb', bytes: 1234, dir: false });
  assert.equal(byPath['scripts/Scenario.js'].bytes, 'export default class {}'.length);
});

test('202. DW-4.3 contents honour the entry cap, at the boundary, and refuse a non-ZIP', async () => {
  const buffer = validArchive();   // 3 entries
  await withFile(buffer, async file => {
    assert.equal((await listArchiveEntries(file, { maxEntries: 3 })).length, 3);
    await assert.rejects(listArchiveEntries(file, { maxEntries: 2 }), err => err.status === 400 && /забагато/.test(err.message));
  });
  await withFile(invalidArchives.notAZip(), file =>
    assert.rejects(listArchiveEntries(file), err => err.status === 400));
});

test('202. DW-4.3 manifest fields: id up to 255, version 50, engineVersion 100 characters; one more is a 400', async () => {
  const accept = overrides => withFile(validArchive(overrides), file => validateScenarioArchive(file, null));
  const refuse = overrides => withFile(validArchive(overrides), file =>
    assert.rejects(validateScenarioArchive(file, null), err => err.status === 400));

  await accept({ id: 'i'.repeat(255) });
  await accept({ version: 'v'.repeat(50) });
  await accept({ engineVersion: 'e'.repeat(100) });
  await refuse({ id: 'i'.repeat(256) });
  await refuse({ version: 'v'.repeat(51) });
  await refuse({ engineVersion: 'e'.repeat(101) });
});

test('202. DW-4.3 a manifest id, name or version that is not text is a 400, never "[object Object]"', async () => {
  for (const overrides of [{ id: { a: 1 } }, { name: { a: 1 } }, { version: { a: 1 } }, { version: 1 }, { name: ['x'] }, { engineVersion: 7 }]) {
    await withFile(validArchive(overrides), file =>
      assert.rejects(validateScenarioArchive(file, null), err => err.status === 400 && /рядком/.test(err.message), JSON.stringify(overrides)));
  }
});
