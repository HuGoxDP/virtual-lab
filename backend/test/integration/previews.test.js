// backend/test/integration/previews.test.js
//
// Test-plan scenarios 199-201 (DW-4.2, DW-4.6): preview upload and removal (owner or moderator),
// accepted and dirty files, the `imageUrl` rule on PUT/POST, GC and the storage report over both
// stores, and migration 012 clearing external image URLs (run twice).

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');

const { removeArchiveRoot } = require('../helpers/app-env');
const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { createKey } = require('../helpers/keys');
const { png, jpeg, padTo, MIB } = require('../helpers/images');

let available = false;
const keys = {};

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
  keys.owner = await createKey(pool, 'author', 'Alice');
  keys.other = await createKey(pool, 'author', 'Bob');
  keys.moderator = await createKey(pool, 'moderator', 'Mia');
  await pool.query("UPDATE scenarios SET owner_key_id = $1 WHERE id = 'cell-biology'", [keys.owner.id]);
});

test.beforeEach(() => failedAuth.reset());

test.after(async () => {
  if (available) await truncateAll(pool);
  await pool.end();
  await removeArchiveRoot();
  await fsp.rm(storage.PREVIEW_ROOT, { recursive: true, force: true });
});

function skipUnlessDb(t) {
  if (!available) {
    t.skip('no database reachable — set DB_HOST/DB_NAME to run integration tests');
    return true;
  }
  return false;
}

const image = id => pool.query('SELECT image_url FROM scenarios WHERE id = $1', [id]).then(r => r.rows[0].image_url);
const upload = (buffer, name, auth = keys.owner.auth, id = 'cell-biology', type = 'application/octet-stream') =>
  request(app).post(`/api/scenarios/${id}/preview`).set(auth).attach('preview', buffer, { filename: name, contentType: type });
const stored = () => fsp.readdir(storage.previews.objectsDir);
const leftovers = () => fsp.readdir(storage.previews.tmpDir);

test('199. DW-4.2 a PNG and a JPEG at 800 px are stored by hash, the row points at /previews/, and the file is on disk', async t => {
  if (skipUnlessDb(t)) return;
  for (const [buffer, name, ext] of [[png(800, 500), 'cover.png', 'png'], [jpeg(1600, 1000), 'cover.jpg', 'jpg']]) {
    const res = await upload(buffer, name).expect(200);
    assert.match(res.body.imageUrl, new RegExp(`^/previews/[0-9a-f]{64}\\.${ext}$`));
    assert.deepEqual(res.body.warnings, []);
    assert.equal(await image('cell-biology'), res.body.imageUrl);
    assert.deepEqual(await fsp.readFile(path.join(storage.previews.objectsDir, path.basename(res.body.imageUrl))), buffer);
  }
  assert.deepEqual(await leftovers(), []);
  const events = await pool.query("SELECT details FROM audit_events WHERE action = 'scenario.preview' ORDER BY id");
  assert.equal(events.rows.length, 2);
  assert.equal(events.rows[1].details.width, 1600);
});

test('199. DW-4.2 5 MiB exactly is stored; 16:9 is stored with a warning; a moderator may upload for anyone', async t => {
  if (skipUnlessDb(t)) return;
  await upload(padTo(png(800, 500), 5 * MIB), 'big.png').expect(200);
  const wide = await upload(jpeg(1920, 1080), 'wide.jpg', keys.moderator.auth).expect(200);
  assert.equal(wide.body.warnings.length, 1);
  assert.match(wide.body.warnings[0], /16:10/);
});

test('200. DW-4.2 dirty files -> 400 and nothing stored or changed', async t => {
  if (skipUnlessDb(t)) return;
  const before = await image('cell-biology');
  const filesBefore = await stored();
  const cases = {
    'SVG': [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"/>'), 'cover.png', 'image/png'],
    'GIF': [Buffer.from('GIF89a\x20\x03\xf4\x01', 'latin1'), 'cover.gif', 'image/gif'],
    'text named .png': [Buffer.from('hello'), 'cover.png', 'image/png'],
    'shorter than its header': [png(800, 500).subarray(0, 20), 'cover.png', 'image/png'],
    'JPEG header cut': [jpeg(800, 500).subarray(0, 10), 'cover.jpg', 'image/jpeg'],
    '5 MiB + 1 byte': [padTo(png(800, 500), 5 * MIB + 1), 'cover.png', 'image/png'],
    '799 px': [png(799, 499), 'cover.png', 'image/png'],
    'a ZIP': [Buffer.from('504b0304', 'hex'), 'cover.png', 'image/png'],
  };
  for (const [name, [buffer, file, type]] of Object.entries(cases)) {
    const res = await upload(buffer, file, keys.owner.auth, 'cell-biology', type);
    assert.equal(res.status, 400, name);
    assert.equal(typeof res.body.error, 'string', name);
  }
  assert.equal(await image('cell-biology'), before);
  assert.deepEqual(await stored(), filesBefore);
  assert.deepEqual(await leftovers(), []);
});

test('200. DW-4.2 the type is the bytes: a PNG named .jpg and a JPEG claiming image/png are accepted as what they are', async t => {
  if (skipUnlessDb(t)) return;
  const a = await upload(png(850, 531), 'photo.jpg', keys.owner.auth, 'cell-biology', 'image/jpeg').expect(200);
  assert.match(a.body.imageUrl, /\.png$/);
  const b = await upload(jpeg(850, 531), 'photo.png', keys.owner.auth, 'cell-biology', 'image/png').expect(200);
  assert.match(b.body.imageUrl, /\.jpg$/);
});

test('199. DW-4.2 no file or the wrong field -> 400; stranger 403; unknown scenario 404; anonymous 401', async t => {
  if (skipUnlessDb(t)) return;
  await request(app).post('/api/scenarios/cell-biology/preview').set(keys.owner.auth).expect(400);
  await request(app).post('/api/scenarios/cell-biology/preview').set(keys.owner.auth).attach('archive', png(800, 500), 'x.png').expect(400);
  const before = await image('cell-biology');
  await upload(png(900, 562), 'x.png', keys.other.auth).expect(403);
  await upload(png(900, 562), 'x.png', keys.owner.auth, 'no-such').expect(404);
  await request(app).post('/api/scenarios/cell-biology/preview').attach('preview', png(800, 500), 'x.png').expect(401);
  assert.equal(await image('cell-biology'), before);
});

test('199. DW-4.2 DELETE clears the cover (owner or moderator), is idempotent, and a stranger gets 403', async t => {
  if (skipUnlessDb(t)) return;
  await upload(png(1000, 625), 'x.png').expect(200);
  await request(app).delete('/api/scenarios/cell-biology/preview').set(keys.other.auth).expect(403);
  assert.notEqual(await image('cell-biology'), '');
  await request(app).delete('/api/scenarios/cell-biology/preview').set(keys.owner.auth).expect(200);
  assert.equal(await image('cell-biology'), '');
  await request(app).delete('/api/scenarios/cell-biology/preview').set(keys.moderator.auth).expect(200);
  await request(app).delete('/api/scenarios/no-such/preview').set(keys.moderator.auth).expect(404);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'scenario.preview.remove'")).rows[0].n, 1, 'the no-op is not journalled');
});

test('201. DW-4.6 the imageUrl rule: an author PUT with any imageUrl -> 400; a moderator may send "", the current value or /previews/...', async t => {
  if (skipUnlessDb(t)) return;
  const current = (await upload(png(1000, 625), 'x.png').expect(200)).body.imageUrl;

  for (const imageUrl of ['', current, 'https://x/y.png']) {
    await request(app).put('/api/catalog/cell-biology').set(keys.owner.auth).send({ imageUrl }).expect(400);
  }
  const put = body => request(app).put('/api/catalog/cell-biology').set(keys.moderator.auth).send(body);
  await put({ imageUrl: 'https://images.unsplash.com/x.jpg' }).expect(400);
  await put({ imageUrl: '//evil.example/x.png' }).expect(400);
  await put({ imageUrl: '/assets/other.jpg' }).expect(400);
  await put({ imageUrl: 5 }).expect(400);
  assert.equal(await image('cell-biology'), current, 'refusals changed nothing');

  await put({ title: 'Same', imageUrl: current }).expect(200);
  const other = (await upload(png(1100, 688), 'y.png', keys.moderator.auth).expect(200)).body.imageUrl;
  await put({ imageUrl: current }).expect(200);          // a stored preview path
  assert.equal(await image('cell-biology'), current);
  await put({ imageUrl: other }).expect(200);
  await put({ imageUrl: '' }).expect(200);
  assert.equal(await image('cell-biology'), '');
});

test('201. DW-4.6 POST /api/catalog: the old admin form sends imageUrl "" (fine); an external URL -> 400; an author may not send it', async t => {
  if (skipUnlessDb(t)) return;
  const body = extra => ({ id: `img-${Math.random().toString(36).slice(2, 8)}`, title: 'T', category: 'biology', categoryLabel: 'Біологія', ...extra });
  await request(app).post('/api/catalog').set(keys.moderator.auth).send(body({ imageUrl: '' })).expect(201);
  await request(app).post('/api/catalog').set(keys.moderator.auth).send(body({ imageUrl: 'https://x/y.png' })).expect(400);
  await request(app).post('/api/catalog').set(keys.moderator.auth).send(body({ imageUrl: '/previews/' + 'a'.repeat(64) + '.png' })).expect(201);
  await request(app).post('/api/catalog').set(keys.owner.auth).send(body({ imageUrl: '' })).expect(400);
});

test('200. DW-4.2 GC and the storage report cover previews: referenced kept, orphans reported and collected, young ones protected', async t => {
  if (skipUnlessDb(t)) return;
  const kept = (await upload(png(1200, 750), 'k.png').expect(200)).body.imageUrl;
  const orphan = await storage.commitPreview(jpeg(1300, 812), 'jpg');
  const young = await storage.commitPreview(png(1400, 875), 'png');
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await fsp.utimes(path.join(storage.previews.objectsDir, `${orphan.sha256}.jpg`), old, old);
  await fsp.utimes(path.join(storage.previews.objectsDir, path.basename(kept)), old, old);

  const report = await request(app).get('/api/admin/storage').set(keys.moderator.auth).expect(200);
  assert.ok(report.body.total && report.body.referenced && report.body.orphans, 'archive shape unchanged');
  assert.equal(report.body.previews.referenced.count, 1);
  assert.deepEqual(report.body.previews.orphans.sample.map(o => o.sha256), [orphan.sha256]);
  assert.equal(report.body.previews.protectedByAge.count >= 1, true);

  const dry = await request(app).post('/api/admin/storage/gc').set(keys.moderator.auth).send({}).expect(200);
  assert.equal(dry.body.previews.wouldDelete.count, 1);
  assert.ok((await stored()).includes(`${orphan.sha256}.jpg`), 'a dry run deletes nothing');

  const swept = await request(app).post('/api/admin/storage/gc').set(keys.moderator.auth).send({ dryRun: false }).expect(200);
  assert.equal(swept.body.previews.deleted.count, 1);
  const left = await stored();
  assert.ok(!left.includes(`${orphan.sha256}.jpg`));
  assert.ok(left.includes(path.basename(kept)));
  assert.ok(left.includes(`${young.sha256}.png`));
});

test('201. DW-4.6 migration 012 clears external image URLs (listing them), keeps same-origin ones, and a second run changes nothing', async t => {
  if (skipUnlessDb(t)) return;
  const sql = await fsp.readFile(path.join(__dirname, '../../migrations/012_previews_and_manifest_id.sql'), 'utf8');
  const urls = {
    'm-https': 'https://images.unsplash.com/photo.jpg', 'm-http': 'http://x.example/a.png', 'm-proto': '//cdn.example/a.png',
    'm-ftp': 'ftp://x/a.png', 'm-assets': '/assets/scenarios/a.jpg', 'm-prev': `/previews/${'a'.repeat(64)}.png`, 'm-empty': '',
  };
  for (const [id, url] of Object.entries(urls)) {
    await pool.query("INSERT INTO scenarios (id, title, category, category_label, image_url) VALUES ($1, 'T', 'biology', 'Б', $2)", [id, url]);
  }
  const notices = [];
  const client = await pool.connect();
  client.on('notice', n => notices.push(n.message));
  try {
    await client.query(sql);
    const first = (await pool.query("SELECT id, image_url FROM scenarios WHERE id LIKE 'm-%' ORDER BY id")).rows;
    await client.query(sql);
    const second = (await pool.query("SELECT id, image_url FROM scenarios WHERE id LIKE 'm-%' ORDER BY id")).rows;
    assert.deepEqual(second, first, 'idempotent');
    const byId = Object.fromEntries(first.map(r => [r.id, r.image_url]));
    for (const id of ['m-https', 'm-http', 'm-proto', 'm-ftp']) assert.equal(byId[id], '', id);
    assert.equal(byId['m-assets'], urls['m-assets']);
    assert.equal(byId['m-prev'], urls['m-prev']);
  } finally {
    client.release();
  }
  assert.equal(notices.length, 4, 'each cleared row is listed once, on the first run only');
  assert.ok(notices.some(n => n.includes('m-https') && n.includes('unsplash')));
  const width = (await pool.query("SELECT character_maximum_length AS n FROM information_schema.columns WHERE table_name = 'scenarios' AND column_name = 'manifest_id'")).rows[0].n;
  assert.equal(width, 255, 'scenarios.manifest_id matches scenario_versions.manifest_id');
});
