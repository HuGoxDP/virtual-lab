// backend/test/integration/rights-table.test.js
//
// B6 (DW-6.1): the rights table of `unity-editor-plan.md` §7, one `describe` per
// row, every cell called by the caller it belongs to and by the callers it does
// not. The rows are quoted verbatim above each block.
//
//   | Действие | Ключ автора | `ADMIN_TOKEN` |
//   |---|---|---|
//   | Создать сценарий | Да — всегда скрытым, владельцем становится ключ | Да |
//   | Изменить описание, обложку, версию своего сценария | Да | Да |
//   | Загрузить архив в свой **скрытый** сценарий | Да | Да |
//   | Загрузить архив в **опубликованный** сценарий | Только как черновик (см. ниже) | Да, сразу |
//   | Принять или отклонить чужой черновик | Нет | Да |
//   | Опубликовать, скрыть, удалить | Нет | Да |
//   | Трогать чужие сценарии; хранилище; телеметрия | Нет | Да |
//
// The callers: the owning author, another author (the "чужой" column), a
// moderator key, the bootstrap `ADMIN_TOKEN`, a revoked key, the key a rotation
// replaced, and no caller at all. Every "Нет" cell asserts the status *and*
// that the database did not move.

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

// storage.js reads ARCHIVE_ROOT at load, so it is set before server.js is required.
const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-rt-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const { app, pool } = require('../../server');
const storage = require('../../storage');
const { failedAuth, authorUploads } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { createKey, revokeKey } = require('../helpers/keys');
const { validArchive } = require('../helpers/fixtures');

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const ANONYMOUS = {};

let available = false;
let owner, other, moderator, revoked, rotatedAway;
const own = 'rt-own-draft';      // the owner's unpublished scenario
const live = 'rt-own-live';      // the owner's published scenario
const foreign = 'rt-other-live'; // another author's published scenario, with a pending draft

/**
 * What each of the three callers without rights answers: a revoked key and the key a
 * rotation replaced are 403 (a credential was presented and refused), an anonymous
 * caller is 401 (none was). The loops below index this by their position.
 */
const REFUSED = [403, 403, 401];

const row = async id => (await pool.query('SELECT * FROM scenarios WHERE id = $1', [id])).rows[0];
const keyCount = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM publish_keys')).rows[0].n;

const upload = (id, headers, archive = validArchive()) => request(app).post(`/api/scenarios/${id}/archive`)
  .set(headers).attach('archive', archive, 'scenario.zip');

const versions = async id => (await pool.query(
  'SELECT id::int AS id, sha256, state FROM scenario_versions WHERE scenario_id = $1 ORDER BY id', [id])).rows;

before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);

  owner = await createKey(pool, 'author', 'РоботOwner');
  other = await createKey(pool, 'author', 'РоботOther');
  moderator = await createKey(pool, 'moderator', 'РоботModerator');
  revoked = await createKey(pool, 'author', 'РоботRevoked');

  // The owner has one unpublished and one published scenario of their own.
  for (const [id, status] of [[own, 'draft'], [live, 'published']]) {
    await pool.query(
      `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
       VALUES ($1, 'Власний', '', 'biology', 'Біологія', $2, $3)`,
      [id, status, owner.id]
    );
  }

  // Another author owns a published scenario and uploaded a draft into it, so
  // "accept or reject someone else's draft" has a row to act on.
  await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, 'Чужий', '', 'biology', 'Біологія', 'published', $2)`,
    [foreign, other.id]
  );
  const pending = await upload(foreign, other.auth).expect(201);
  assert.equal(pending.body.version.state, 'pending');

  // A key whose scenarios were handed to a replacement by rotation.
  const before = await createKey(pool, 'author', 'РоботRotated');
  await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, 'Замінений', '', 'biology', 'Біологія', 'draft', $2)`,
    ['rt-rotated-away', before.id]
  );
  const replacement = await request(app).post(`/api/keys/${before.id}/rotate`).set(BOOTSTRAP).expect(201);
  rotatedAway = {
    id: before.id,
    auth: before.auth,
    replacement: { id: replacement.body.id, auth: { Authorization: `Bearer ${replacement.body.token}` } },
  };
  await revokeKey(pool, revoked.id);
});

beforeEach(() => { failedAuth.reset(); authorUploads.reset(); });

after(async () => {
  if (available) await truncateAll(pool);
  await pool.end();
  await fsp.rm(ARCHIVE_ROOT, { recursive: true, force: true });
});

function skipUnlessDb(t) {
  if (!available) {
    t.skip('no database reachable — set DB_HOST/DB_NAME to run integration tests');
    return true;
  }
  return false;
}

describe('§7 «Создать сценарий | Да — всегда скрытым, владельцем становится ключ | Да»', () => {
  it('refuses the callers without a live key, creates for the authors and the admins', async t => {
    if (skipUnlessDb(t)) return;

    await t.test('an administrator-issued draft is a draft owned by the issuing key or by the bootstrap', async () => {
      const mine = await request(app).post('/api/catalog').set(owner.auth)
        .send({ id: 'rt-made-owner', title: 'Мій', category: 'biology', status: 'published' })
        .expect(201);
      assert.equal(mine.body.id, 'rt-made-owner');
      const created = await row('rt-made-owner');
      assert.equal(created.status, 'draft', 'always hidden, whatever the body asked for');
      assert.equal(created.owner_key_id, owner.id, 'the caller becomes the owner');
      assert.equal(created.author, 'РоботOwner');

      await request(app).post('/api/catalog').set(moderator.auth)
        .send({ id: 'rt-made-mod', title: 'Модератор', category: 'biology', categoryLabel: 'Біологія' })
        .expect(201);
      assert.equal((await row('rt-made-mod')).status, 'draft');

      await request(app).post('/api/catalog').set(BOOTSTRAP)
        .send({ id: 'rt-made-boot', title: 'Адмін', category: 'biology', categoryLabel: 'Біологія' })
        .expect(201);
      const boot = await row('rt-made-boot');
      assert.equal(boot.status, 'draft');
      assert.equal(boot.owner_key_id, null, 'the bootstrap token owns nothing');
    });

    await t.test('a revoked, a rotated-away and an anonymous caller are refused and create nothing', async () => {
      for (const [i, headers] of [revoked.auth, rotatedAway.auth, ANONYMOUS].entries()) {
        await request(app).post('/api/catalog').set(headers)
          .send({ id: 'rt-made-no', title: 'Ні', category: 'biology', categoryLabel: 'Біологія' })
          .expect(REFUSED[i]);
        assert.equal(await row('rt-made-no'), undefined);
      }
    });
  });
});

describe('§7 «Изменить описание, обложку, версию своего сценария | Да | Да»', () => {
  it('lets the owner edit their own row and the admins edit any; others get 403', async t => {
    if (skipUnlessDb(t)) return;

    await t.test('the owner changes their own row', async () => {
      const res = await request(app).put(`/api/catalog/${own}`).set(owner.auth)
        .send({ title: 'Новий заголовок', description: 'Новий опис', version: '2.0.0' })
        .expect(200);
      assert.equal(res.body.id, own);
      const changed = await row(own);
      assert.equal(changed.title, 'Новий заголовок');
      assert.equal(changed.version, '2.0.0');
    });

    await t.test("another author's row is 403 and does not move", async () => {
      const before = await row(own);
      await request(app).put(`/api/catalog/${own}`).set(other.auth)
        .send({ title: 'Захоплено' }).expect(403);
      const after = await row(own);
      assert.equal(after.title, before.title);
      assert.equal(after.version, before.version);
    });

    await t.test('a moderator and the bootstrap may edit it; a cover URL becomes valid', async () => {
      await request(app).put(`/api/catalog/${own}`).set(moderator.auth)
        .send({ title: 'Правка модератора', author: 'Підпис модератора', scenarioUrl: '/scenarios/x.zip' })
        .expect(200);
      const mod = await row(own);
      assert.equal(mod.title, 'Правка модератора');
      assert.equal(mod.author, 'Підпис модератора');
      assert.equal(mod.scenario_url, '/scenarios/x.zip');

      await request(app).put(`/api/catalog/${own}`).set(BOOTSTRAP)
        .send({ description: 'Правка адміна' }).expect(200);
      assert.equal((await row(own)).description, 'Правка адміна');
    });

    await t.test('a revoked, a rotated-away and an anonymous caller are refused', async () => {
      for (const [i, headers] of [revoked.auth, rotatedAway.auth, ANONYMOUS].entries()) {
        await request(app).put(`/api/catalog/${own}`).set(headers).send({ title: 'Ні' }).expect(REFUSED[i]);
      }
      assert.equal((await row(own)).title, 'Правка модератора');
    });
  });
});

describe('§7 «Загрузить архив в свой **скрытый** сценарий | Да | Да»', () => {
  it('lets the owner and the admins store a version into an unpublished row', async t => {
    if (skipUnlessDb(t)) return;

    await t.test('the owner uploads into their own unpublished scenario', async () => {
      const res = await upload(own, owner.auth).expect(201);
      assert.equal(res.body.version.state, 'current');
      const stored = await row(own);
      assert.match(stored.archive_sha256, /^[0-9a-f]{64}$/);
      assert.equal(stored.status, 'draft', 'an upload does not publish anything');
    });

    await t.test("someone else's unpublished scenario is 403 and stores nothing", async () => {
      const before = await row(own);
      await upload(own, other.auth).expect(403);
      const after = await row(own);
      assert.equal(after.archive_sha256, before.archive_sha256);
      assert.equal((await versions(own)).length, 1, 'no second version was added');
    });

    await t.test('a moderator and the bootstrap upload too, each a new current version', async () => {
      // Distinct content, so neither upload is the identical-object shortcut.
      await upload(own, moderator.auth, validArchive({ version: '2.0.0' })).expect(201);
      await upload(own, BOOTSTRAP, validArchive({ version: '3.0.0' })).expect(201);
      const stored = await versions(own);
      assert.equal(stored.length, 3, 'one row per upload');
      assert.equal(stored[2].state, 'current', 'the newest upload is the current version');
      assert.equal(stored[0].state, 'archived', 'the first upload is archived history');
      assert.match((await row(own)).archive_sha256, /^[0-9a-f]{64}$/);
    });

    await t.test('a revoked, a rotated-away and an anonymous caller are refused', async () => {
      await upload(own, revoked.auth).expect(403);
      await upload(own, rotatedAway.auth).expect(403);
      await upload(own, ANONYMOUS).expect(401);
      assert.equal((await versions(own)).length, 3, 'still three versions');
    });
  });
});

describe('§7 «Загрузить архив в **опубликованный** сценарий | Только как черновик (см. ниже) | Да, сразу»', () => {
  it("stores the owner's upload as a pending draft, and an admin's as the live one", async t => {
    if (skipUnlessDb(t)) return;

    await t.test("the owner's upload is a draft: students keep the current archive", async () => {
      const res = await upload(live, owner.auth).expect(201);
      assert.equal(res.body.version.state, 'pending');
      const stored = await row(live);
      assert.equal(stored.archive_sha256, null, 'the live row is untouched');
      assert.equal(stored.status, 'published');
      const pendingVersions = (await versions(live)).filter(v => v.state === 'pending');
      assert.equal(pendingVersions.length, 1, 'exactly one draft is waiting');
    });

    await t.test("someone else's published scenario is 403, and their draft is still theirs", async () => {
      const before = await row(live);
      await upload(live, other.auth).expect(403);
      assert.equal((await row(live)).archive_sha256, before.archive_sha256);
      const stored = await versions(live);
      assert.equal(stored.filter(v => v.state === 'pending').length, 1, 'no draft of another author');
    });

    await t.test("a moderator's upload replaces the live archive at once", async () => {
      const before = await row(live);
      await upload(live, moderator.auth, validArchive({ version: '2.0.0' })).expect(201);
      const stored = await row(live);
      assert.match(stored.archive_sha256, /^[0-9a-f]{64}$/);
      assert.notEqual(stored.archive_sha256, before.archive_sha256);
      assert.equal((await versions(live)).filter(v => v.state === 'current').length, 1);
    });

    await t.test('a revoked, a rotated-away and an anonymous caller are refused', async () => {
      await upload(live, revoked.auth).expect(403);
      await upload(live, rotatedAway.auth).expect(403);
      await upload(live, ANONYMOUS).expect(401);
    });
  });
});

describe('§7 «Принять или отклонить чужой черновик | Нет | Да»', () => {
  it('answers an author 403 even for their own draft, and the admins 200', async t => {
    if (skipUnlessDb(t)) return;

    const pendingId = async () => (await versions(foreign)).find(v => v.state === 'pending')?.id;

    await t.test('the author who owns the pending draft cannot accept it', async () => {
      // `foreign` is other's own published scenario, so this is the "owner"
      // calling on their own draft: the row says "Нет" for a key of an author.
      const id = await pendingId();
      assert.ok(id, 'the fixture left a draft to judge');
      await request(app).post(`/api/scenarios/${foreign}/versions/${id}/accept`).set(other.auth)
        .expect(403);
      assert.equal((await row(foreign)).archive_sha256, null, 'the draft is still a draft');
      assert.equal(await pendingId(), id, 'the draft is still there');
    });

    await t.test('an author who is not the owner cannot accept it either', async () => {
      const id = await pendingId();
      await request(app).post(`/api/scenarios/${foreign}/versions/${id}/accept`).set(owner.auth)
        .expect(403);
      await request(app).post(`/api/scenarios/${foreign}/versions/${id}/reject`).set(owner.auth)
        .expect(403);
      assert.equal(await pendingId(), id, 'the draft survived both calls');
    });

    await t.test('a moderator may accept it, and the pending draft becomes live', async () => {
      const id = await pendingId();
      await request(app).post(`/api/scenarios/${foreign}/versions/${id}/accept`).set(moderator.auth)
        .expect(200);
      const accepted = await row(foreign);
      assert.equal(accepted.archive_sha256, (await versions(foreign)).find(v => v.id === id).sha256);
      assert.equal((await versions(foreign)).find(v => v.id === id).state, 'current');
      assert.equal(await pendingId(), undefined, 'no draft is left waiting');
    });

    await t.test('a moderator may reject another scenario\'s draft, and the live archive stands', async () => {
      // Distinct content, so this is a new proposal and not the identical-object shortcut.
      await upload(foreign, other.auth, validArchive({ version: '2.0.0' })).expect(201);
      const live = await row(foreign);
      const id = await pendingId();
      assert.ok(id, 'a new draft is waiting');
      await request(app).post(`/api/scenarios/${foreign}/versions/${id}/reject`).set(BOOTSTRAP)
        .expect(200);
      const rejected = await row(foreign);
      assert.equal(rejected.archive_sha256, live.archive_sha256, 'the live archive is untouched');
      assert.equal(await pendingId(), undefined, 'the draft is gone');
      assert.equal(rejected.status, 'published');
    });

    await t.test('revoked, rotated-away and anonymous callers are refused', async () => {
      const id = await pendingId();
      for (const [i, headers] of [revoked.auth, rotatedAway.auth, ANONYMOUS].entries()) {
        await request(app).post(`/api/scenarios/${foreign}/versions/${id}/reject`).set(headers)
          .expect(REFUSED[i]);
      }
      assert.equal(await pendingId(), id, 'the draft survived');
    });
  });
});

describe('§7 «Опубликовать, скрыть, удалить | Нет | Да»', () => {
  it('never lets an author publish, hide or delete — not even their own row', async t => {
    if (skipUnlessDb(t)) return;

    await t.test('the compatibility publish field is refused for an author', async () => {
      const res = await request(app).put(`/api/catalog/${live}`).set(owner.auth)
        .send({ isPublished: true }).expect(400);
      assert.match(res.body.error, /isPublished/);
      assert.equal((await row(live)).status, 'published');
    });

    await t.test('an author cannot delete their own scenario', async () => {
      await request(app).delete(`/api/catalog/${own}`).set(owner.auth).expect(403);
      assert.ok(await row(own), 'the row survived');
    });

    await t.test('a moderator and the bootstrap unpublish and delete', async () => {
      await request(app).put(`/api/catalog/${live}`).set(moderator.auth)
        .send({ isPublished: false }).expect(200);
      assert.equal((await row(live)).status, 'draft', 'hidden again');

      await request(app).delete(`/api/catalog/rt-made-mod`).set(BOOTSTRAP).expect(200);
      assert.equal(await row('rt-made-mod'), undefined, 'deleted');
    });

    await t.test('revoked, rotated-away and anonymous callers are refused both ways', async () => {
      for (const [i, headers] of [revoked.auth, rotatedAway.auth, ANONYMOUS].entries()) {
        await request(app).delete(`/api/catalog/${live}`).set(headers).expect(REFUSED[i]);
        await request(app).put(`/api/catalog/${live}`).set(headers).send({ isPublished: false }).expect(REFUSED[i]);
      }
      assert.equal((await row(live)).status, 'draft');
    });
  });
});

describe('§7 «Трогать чужие сценарии; хранилище; телеметрия | Нет | Да»', () => {
  it("keeps another author's rows, the storage tools and the telemetry summary from an author", async t => {
    if (skipUnlessDb(t)) return;

    await t.test("an author cannot read or edit someone else's scenario", async () => {
      const before = await row(foreign);
      const calls = [
        () => request(app).get(`/api/scenarios/${foreign}/versions`).set(owner.auth),
        () => request(app).get(`/api/scenarios/${foreign}/versions/1/contents`).set(owner.auth),
        () => request(app).post(`/api/scenarios/${foreign}/versions/1/checks`).set(owner.auth)
          .send({ checks: {}, manifestVersion: '1.0' }),
        () => request(app).delete(`/api/scenarios/${foreign}/versions/1`).set(owner.auth),
        () => request(app).get(`/api/scenarios/${foreign}/history`).set(owner.auth),
      ];
      for (const call of calls) {
        const res = await call();
        assert.equal(res.status, 403, `${res.req.method} ${res.req.path} answered ${res.status}`);
      }
      assert.equal((await row(foreign)).archive_sha256, before.archive_sha256);
    });

    await t.test('storage and telemetry are moderator-only', async () => {
      const calls = [
        () => request(app).get('/api/admin/storage').set(owner.auth),
        () => request(app).post('/api/admin/storage/gc').set(owner.auth).send({}),
        () => request(app).get('/api/telemetry/summary').set(owner.auth),
        () => request(app).get('/api/keys').set(owner.auth),
        () => request(app).get('/api/admin/scenarios').set(owner.auth).expect(200), // own list, allowed
      ];
      for (const call of calls.slice(0, 4)) {
        const res = await call();
        assert.equal(res.status, 403, `${res.req.method} ${res.req.path} answered ${res.status}`);
      }
      // An author's own list exists and lists only their own scenarios.
      const mine = await request(app).get('/api/admin/scenarios').set(owner.auth).expect(200);
      assert.ok(mine.body.scenarios.length > 0, 'the list is not empty');
      assert.ok(mine.body.scenarios.every(s => s.ownerKeyId === owner.id),
        'no foreign scenario in an author list');
    });

    await t.test('a moderator and the bootstrap may read storage and telemetry', async () => {
      await request(app).get('/api/admin/storage').set(moderator.auth).expect(200);
      await request(app).get('/api/telemetry/summary').set(BOOTSTRAP).expect(200);
      await request(app).get('/api/keys').set(BOOTSTRAP).expect(200);
      assert.equal((await request(app).get('/api/keys').set(BOOTSTRAP).expect(200)).body.keys.length,
        await keyCount(), 'the list is every key');
    });

    await t.test('revoked, rotated-away and anonymous callers are refused everywhere', async () => {
      for (const [i, headers] of [revoked.auth, rotatedAway.auth, ANONYMOUS].entries()) {
        await request(app).get('/api/admin/storage').set(headers).expect(REFUSED[i]);
        await request(app).get('/api/telemetry/summary').set(headers).expect(REFUSED[i]);
        await request(app).get('/api/keys').set(headers).expect(REFUSED[i]);
      }
    });
  });
});

describe('§7 callers without rights, across routes (the sweep asserts the same, per route)', () => {
  it('a rotated-away key keeps nothing, and its replacement keeps what it owns', async t => {
    if (skipUnlessDb(t)) return;

    await t.test('the old token is refused on every route it used to be allowed', async () => {
      await request(app).get('/api/auth/me').set(rotatedAway.auth).expect(403);
      await request(app).put('/api/catalog/rt-rotated-away').set(rotatedAway.auth)
        .send({ title: 'Спробую' }).expect(403);
      await upload('rt-rotated-away', rotatedAway.auth).expect(403);
      assert.equal((await row('rt-rotated-away')).owner_key_id, rotatedAway.replacement.id,
        'the replacement owns the row now');
    });

    await t.test('the replacement key works on exactly what the old one owned', async () => {
      await request(app).get('/api/auth/me').set(rotatedAway.replacement.auth).expect(200);
      await request(app).put('/api/catalog/rt-rotated-away').set(rotatedAway.replacement.auth)
        .send({ title: 'Новий власник' }).expect(200);
      assert.equal((await row('rt-rotated-away')).title, 'Новий власник');
    });
  });
});
