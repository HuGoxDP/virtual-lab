// backend/test/integration/workflow-version-bind.test.js
//
// B6 phase 4 (DW-4.1): approve is bound to the version the moderator reviewed.
// A version swapped between the review and the click is a 409, and nothing is
// written — the status stays and the audit row stays absent.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const { createKey } = require('../helpers/keys');
const { validArchive, png } = require('../helpers/fixtures');

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

let available = false;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  await truncateAll(pool);
});

test.beforeEach(() => failedAuth.reset());

test.after(async () => {
  if (available) await truncateAll(pool);
  await pool.end();
});

function skipUnlessDb(t) {
  if (!available) {
    t.skip('no database reachable — set DB_HOST/DB_NAME to run integration tests');
    return true;
  }
  return false;
}

/** A draft scenario owned by `key`, with `count` uploaded versions; the ids, oldest first. */
async function scenarioWithVersions(key, count) {
  const { rows } = await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, 'Bind Me', '', 'bio', 'Біологія', 'review', $2) RETURNING id`,
    [`bind-${key.id}-${Math.random().toString(36).slice(2, 6)}`, key.id]
  );
  const id = rows[0].id;
  const ids = [];
  for (let i = 0; i < count; i++) {
    // Only one row may be 'current' (idx_scenario_versions_one_current), so the
    // previous one is superseded BEFORE the new row is inserted.
    if (ids.length) {
      await pool.query('UPDATE scenario_versions SET state = $1 WHERE scenario_id = $2 AND state = $3', ['archived', id, 'current']);
    }
    const v = await pool.query(
      `INSERT INTO scenario_versions (scenario_id, sha256, bytes, state)
       VALUES ($1, $2, $3, 'current') RETURNING id`,
      [id, `sha-${i}`.padEnd(64, '0'), 1000 + i]
    );
    ids.push(v.rows[0].id);
  }
  return { id, versionIds: ids };
}

test('B6.4 DW-4.1: approve with a stale versionId is a 409 that writes nothing', async t => {
  if (skipUnlessDb(t)) return;

  const author = await createKey(pool, 'author', 'Bound Author');
  const { id, versionIds } = await scenarioWithVersions(author, 2);

  await t.test('the reviewed id is v1 while the live one is v2', async () => {
    const res = await request(app).post(`/api/scenarios/${id}/approve`).set(BOOTSTRAP)
      .send({ versionId: versionIds[0] }).expect(409);
    assert.match(res.body.error, /Архів змінився/);
  });

  await t.test('the status and the current version are untouched, and no audit row was written', async () => {
    const { rows } = await pool.query('SELECT status FROM scenarios WHERE id = $1', [id]);
    assert.equal(rows[0].status, 'review');
    const v = await pool.query("SELECT id FROM scenario_versions WHERE scenario_id = $1 AND state = 'current'", [id]);
    assert.equal(v.rows[0].id, versionIds[1], 'the live version is still v2');
    const a = await pool.query("SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'scenario.approve'");
    assert.equal(a.rows[0].n, 0);
  });

  await t.test('the live version publishes', async () => {
    const res = await request(app).post(`/api/scenarios/${id}/approve`).set(BOOTSTRAP)
      .send({ versionId: versionIds[1] }).expect(200);
    assert.equal(res.body.status, 'published');
  });
});

test('B6.4 approve without a versionId is unchanged (scripts and PUT keep working)', async t => {
  if (skipUnlessDb(t)) return;
  const author = await createKey(pool, 'author', 'No Version Author');
  const { id, versionIds } = await scenarioWithVersions(author, 1);
  await request(app).post(`/api/scenarios/${id}/approve`).set(BOOTSTRAP).expect(200);
  const { rows } = await pool.query('SELECT status FROM scenarios WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'published');
});

test('B6.4 a malformed versionId is a 400', async t => {
  if (skipUnlessDb(t)) return;
  const author = await createKey(pool, 'author', 'Bad Id Author');
  const { id } = await scenarioWithVersions(author, 1);
  for (const bad of [0, -1, 2147483648, 1.5, '1']) {
    await request(app).post(`/api/scenarios/${id}/approve`).set(BOOTSTRAP).send({ versionId: bad }).expect(400);
  }
});
