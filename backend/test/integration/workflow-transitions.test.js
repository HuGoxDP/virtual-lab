// backend/test/integration/workflow-transitions.test.js
//
// Test-plan scenario 188 (DW-3.2): the status transition table for every
// (status x action x caller), each success writing an audit event; the dirty cases
// (concurrent approves, reject note length, no archive). The expected answers below are
// written out by hand from the plan, not derived from `workflow.js`.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios, addCurrentVersion } = require('../helpers/db');
const { createKey } = require('../helpers/keys');

const BOOTSTRAP = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };

let available = false;
const keys = {};

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
  keys.owner = await createKey(pool, 'author', 'Alice');
  keys.other = await createKey(pool, 'author', 'Bob');
  keys.moderator = await createKey(pool, 'moderator', 'Mia');
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

const CALLERS = {
  anonymous: () => ({}),
  owner: () => keys.owner.auth,
  other: () => keys.other.auth,
  moderator: () => keys.moderator.auth,
  bootstrap: () => BOOTSTRAP,
};

const STATUSES = ['draft', 'review', 'published', 'rejected'];

/** action -> [statuses it may start from, resulting status, callers who may do it] */
const RULES = {
  submit:    { from: ['draft', 'rejected'],            to: 'review',    may: ['owner', 'moderator', 'bootstrap'] },
  withdraw:  { from: ['review'],                       to: 'draft',     may: ['owner', 'moderator', 'bootstrap'] },
  approve:   { from: ['review', 'draft', 'rejected'],  to: 'published', may: ['moderator', 'bootstrap'] },
  reject:    { from: ['review'],                       to: 'rejected',  may: ['moderator', 'bootstrap'] },
  unpublish: { from: ['published'],                    to: 'draft',     may: ['moderator', 'bootstrap'] },
};

/** What `caller` gets for `action` on a row at `status`: 401 nothing presented, 403 not allowed, 409 wrong state. */
function expectedStatus(action, status, caller) {
  if (caller === 'anonymous') return 401;
  if (!RULES[action].may.includes(caller)) return 403;
  return RULES[action].from.includes(status) ? 200 : 409;
}

let counter = 0;

/** A fresh row owned by Alice at `status`, with a current archive version unless `archive` is false. */
async function makeRow(status, { archive = true } = {}) {
  const id = `wf-${++counter}`;
  await pool.query(`
    INSERT INTO scenarios (id, title, category, category_label, status, owner_key_id, moderator_note)
    VALUES ($1, 'T', 'biology', 'Біологія', $2, $3, 'old note')`, [id, status, keys.owner.id]);
  if (archive) await addCurrentVersion(pool, id, String(counter).padStart(64, '0'));
  return id;
}

const rowOf = async id => (await pool.query('SELECT * FROM scenarios WHERE id = $1', [id])).rows[0];
const auditActions = async id => (await pool.query(
  'SELECT action FROM audit_events WHERE scenario_id = $1 ORDER BY id', [id])).rows.map(r => r.action);
const act = (id, action, as, body) => request(app).post(`/api/scenarios/${id}/${action}`).set(CALLERS[as]()).send(body);

test('188. transition matrix: status x action x caller (DW-3.2)', async t => {
  if (skipUnlessDb(t)) return;

  for (const action of Object.keys(RULES)) {
    for (const status of STATUSES) {
      for (const caller of Object.keys(CALLERS)) {
        const want = expectedStatus(action, status, caller);
        await t.test(`${action} from ${status} as ${caller} -> ${want}`, async () => {
          const id = await makeRow(status);
          const res = await act(id, action, caller);
          assert.equal(res.status, want, JSON.stringify(res.body));

          const after = await rowOf(id);
          if (want === 200) {
            assert.equal(after.status, RULES[action].to);
            assert.equal(res.body.status, RULES[action].to);
            assert.equal(res.body.isPublished, RULES[action].to === 'published');
            assert.deepEqual(await auditActions(id), [`scenario.${action}`], 'one audit event per success');
          } else {
            assert.equal(after.status, status, 'a refused action changes nothing');
            assert.deepEqual(await auditActions(id), [], 'and is not journalled');
          }
        });
      }
    }
  }
});

test('188. an unknown scenario -> 404 for every action', async t => {
  if (skipUnlessDb(t)) return;
  for (const action of Object.keys(RULES)) {
    await t.test(action, async () => {
      await act('wf-nope', action, 'moderator').expect(404);
    });
  }
});

test('188. submit and approve need a current archive; reject and unpublish do not (DW-3.2)', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('submit without an archive -> 409, still a draft', async () => {
    const id = await makeRow('draft', { archive: false });
    const res = await act(id, 'submit', 'owner').expect(409);
    assert.match(res.body.error, /архів/);
    assert.equal((await rowOf(id)).status, 'draft');
  });

  await t.test('approve without an archive -> 409, from every status it could start from', async () => {
    for (const status of ['draft', 'review', 'rejected']) {
      const id = await makeRow(status, { archive: false });
      await act(id, 'approve', 'moderator').expect(409);
      assert.equal((await rowOf(id)).status, status);
    }
  });

  await t.test('a streaming-only published row keeps published; after unpublish it needs an archive first', async () => {
    const id = await makeRow('published', { archive: false });
    await pool.query("UPDATE scenarios SET manifest_url = '/a/x.json' WHERE id = $1", [id]);
    assert.equal((await rowOf(id)).status, 'published');
    await act(id, 'unpublish', 'moderator').expect(200);
    await act(id, 'approve', 'moderator').expect(409);
    await addCurrentVersion(pool, id, 'e'.repeat(64));
    await act(id, 'approve', 'moderator').expect(200);
  });

  await t.test('reject and unpublish work on a row with no archive', async () => {
    const review = await makeRow('review', { archive: false });
    await act(review, 'reject', 'moderator').expect(200);
    const live = await makeRow('published', { archive: false });
    await act(live, 'unpublish', 'moderator').expect(200);
  });
});

test('188. reject note, submitted_at and the moderator note lifecycle (DW-3.2)', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('no note -> the default text', async () => {
    const id = await makeRow('review');
    const res = await act(id, 'reject', 'moderator', {}).expect(200);
    assert.equal(res.body.moderatorNote, 'Потрібні уточнення від модератора.');
    assert.equal((await rowOf(id)).moderator_note, 'Потрібні уточнення від модератора.');
  });

  await t.test('a blank note -> the default text; surrounding spaces are trimmed', async () => {
    const blank = await makeRow('review');
    assert.equal((await act(blank, 'reject', 'moderator', { note: '   ' }).expect(200)).body.moderatorNote,
      'Потрібні уточнення від модератора.');
    const padded = await makeRow('review');
    assert.equal((await act(padded, 'reject', 'moderator', { note: '  Додайте опис  ' }).expect(200)).body.moderatorNote,
      'Додайте опис');
  });

  await t.test('2000 characters are kept whole, 2001 -> 400 and nothing changes', async () => {
    const ok = await makeRow('review');
    await act(ok, 'reject', 'moderator', { note: 'я'.repeat(2000) }).expect(200);
    assert.equal((await rowOf(ok)).moderator_note.length, 2000);

    const bad = await makeRow('review');
    await act(bad, 'reject', 'moderator', { note: 'я'.repeat(2001) }).expect(400);
    const after = await rowOf(bad);
    assert.equal(after.status, 'review');
    assert.equal(after.moderator_note, 'old note');
  });

  await t.test('a note that is not a string -> 400', async () => {
    const id = await makeRow('review');
    for (const note of [5, {}, ['x'], true]) await act(id, 'reject', 'moderator', { note }).expect(400);
  });

  await t.test('the note is in the audit details', async () => {
    const id = await makeRow('review');
    await act(id, 'reject', 'moderator', { note: 'Потрібне прев’ю' }).expect(200);
    const { rows } = await pool.query("SELECT details FROM audit_events WHERE scenario_id = $1 AND action = 'scenario.reject'", [id]);
    assert.deepEqual(rows[0].details, { from: 'review', to: 'rejected', note: 'Потрібне прев’ю' });
  });

  await t.test('submit stamps submitted_at and clears the note; withdraw keeps both', async () => {
    const id = await makeRow('rejected');
    assert.equal((await rowOf(id)).submitted_at, null);
    const submitted = await act(id, 'submit', 'owner').expect(200);
    assert.equal(submitted.body.moderatorNote, null, 'a resubmission starts without the old rejection note');
    const stamped = (await rowOf(id)).submitted_at;
    assert.ok(stamped instanceof Date);
    await act(id, 'withdraw', 'owner').expect(200);
    assert.deepEqual((await rowOf(id)).submitted_at, stamped);
  });

  await t.test('approve clears the note; unpublish keeps the row otherwise as it was', async () => {
    const id = await makeRow('rejected');
    await act(id, 'approve', 'moderator').expect(200);
    assert.equal((await rowOf(id)).moderator_note, null);
    await act(id, 'unpublish', 'moderator').expect(200);
    assert.equal((await rowOf(id)).status, 'draft');
  });
});

test('188. two concurrent approves: exactly one succeeds, the other is a 409 (DW-3.2)', async t => {
  if (skipUnlessDb(t)) return;

  for (const round of [1, 2, 3]) {
    await t.test(`round ${round}`, async () => {
      const id = await makeRow('review');
      const results = await Promise.all([
        act(id, 'approve', 'moderator'),
        act(id, 'approve', 'bootstrap'),
      ]);
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      assert.deepEqual(await auditActions(id), ['scenario.approve'], 'the loser wrote nothing');
    });
  }
});

test('188. a submit racing a withdraw leaves a consistent row (DW-3.2)', async t => {
  if (skipUnlessDb(t)) return;
  const id = await makeRow('draft');
  const [submit, withdraw] = await Promise.all([act(id, 'submit', 'owner'), act(id, 'withdraw', 'owner')]);
  const final = (await rowOf(id)).status;
  if (submit.status === 200 && withdraw.status === 200) assert.equal(final, 'draft', 'submit then withdraw');
  else {
    assert.equal(submit.status, 200);
    assert.equal(withdraw.status, 409, 'withdraw found it still a draft');
    assert.equal(final, 'review');
  }
});

test('188. only the transitions move a status: a PUT carrying one ignores it (DW-3.2)', async t => {
  if (skipUnlessDb(t)) return;
  const id = await makeRow('draft');

  await request(app).put(`/api/catalog/${id}`).set(keys.moderator.auth).send({ status: 'published' }).expect(400);
  for (const as of ['moderator', 'owner']) {
    await request(app).put(`/api/catalog/${id}`).set(CALLERS[as]()).send({ status: 'published', title: `By ${as}` }).expect(200);
    const after = await rowOf(id);
    assert.equal(after.status, 'draft');
    assert.equal(after.title, `By ${as}`);
  }
});
