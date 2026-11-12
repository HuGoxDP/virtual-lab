// backend/test/integration/key-revocation-race.test.js
//
// B6 phase 7 (F-R1, DW-7.1): a key revoked *while a request is in flight* must not write.
//
// `authenticate` resolves the principal once, at the start of a request, and every write
// route then re-checks ownership under its row lock — never `revoked_at`. A revocation that
// landed between the two was therefore committed: for an archive upload the window was the
// whole body stream. The fix re-reads the key, locked, as the first statement of each write
// transaction; this test holds that line by reproducing the race with a body that is still
// streaming when the key is revoked, and by proving a live key still writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// storage.js reads ARCHIVE_ROOT at load, so it is set before server.js is required.
const ARCHIVE_ROOT = path.join(os.tmpdir(), `vl-rr-${crypto.randomUUID()}`);
process.env.ARCHIVE_ROOT = ARCHIVE_ROOT;

const { app, pool } = require('../../server');
const { inTransaction } = require('../../db');
const auth = require('../../auth');
const storage = require('../../storage');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll, seedScenarios } = require('../helpers/db');
const { createKey, revokeKey } = require('../helpers/keys');
const { validArchive } = require('../helpers/fixtures');

let available = false;
let server;
let baseUrl;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await storage.ensureStorageDirs();
  await prepareSchema(pool);
  await truncateAll(pool);
  await seedScenarios(pool);
  // A real listener, because the race needs a body that is still streaming while the
  // revocation lands — `supertest` sends the whole buffer in one shot.
  await new Promise(resolve => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => failedAuth.reset());

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
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

const row = async id => (await pool.query('SELECT * FROM scenarios WHERE id = $1', [id])).rows[0];
const versionCount = async id =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM scenario_versions WHERE scenario_id = $1', [id])).rows[0].n;

/** A key that owns an unpublished scenario with no versions yet. */
async function ownedScenario(label, slug) {
  const key = await createKey(pool, 'author', label);
  await pool.query(
    `INSERT INTO scenarios (id, title, description, category, category_label, status, owner_key_id)
     VALUES ($1, 'Ключ', '', 'biology', 'Біологія', 'draft', $2)`,
    [slug, key.id]
  );
  return key;
}

/**
 * Opens `POST path` as a multipart upload of `archive`, sends the first half, waits for
 * `whileStreaming`, then sends the rest and the closing boundary. Resolves `{ status, body }`.
 */
function streamUpload(path, headers, archive, whileStreaming) {
  const boundary = `----rr${crypto.randomBytes(8).toString('hex')}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="archive"; `
    + `filename="scenario.zip"\r\nContent-Type: application/zip\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const half = Math.floor(archive.length / 2);
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': Buffer.byteLength(head) + archive.length + Buffer.byteLength(tail),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.write(head);
    req.write(archive.subarray(0, half));
    whileStreaming().then(() => req.end(Buffer.concat([archive.subarray(half), Buffer.from(tail)])), reject);
  });
}

test('F-R1 a key revoked while its upload streams writes nothing', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('the revocation lands while the body is still streaming', async () => {
    const author = await ownedScenario('Revoked In Flight', 'rr-upload');
    const archive = validArchive();

    // Half the body is on the wire — authenticated, being received — when the operator
    // revokes the key. The archive route then reads the finished body and refuses it.
    const answer = await streamUpload('/api/scenarios/rr-upload/archive', author.auth, archive,
      async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        await revokeKey(pool, author.id);
      });

    assert.equal(answer.status, 403, `the upload answered ${answer.status}`);
    assert.equal(answer.body.error, 'Ключ відкликано');
  });

  await t.test('nothing was written, and no object was stored', async () => {
    assert.equal(await versionCount('rr-upload'), 0, 'no version row');
    const stored = await row('rr-upload');
    assert.equal(stored.archive_sha256, null, 'the scenario points at no archive');
    assert.equal(stored.status, 'draft', 'the status did not move');
    assert.equal(stored.updated_at.getTime(), stored.created_at.getTime(), 'the row was not touched');
    assert.deepEqual(await fsp.readdir(storage.OBJECTS_DIR), [], 'the store is empty');
    const audit = await pool.query("SELECT COUNT(*)::int AS n FROM audit_events WHERE action = 'scenario.archive'");
    assert.equal(audit.rows[0].n, 0, 'no journal row either');
  });
});

test('F-R1 a live key still writes everything it could before', async t => {
  if (skipUnlessDb(t)) return;

  await t.test('the same streamed upload commits, and a transition works', async () => {
    const author = await ownedScenario('Still Live', 'rr-live');
    const archive = validArchive();

    const answer = await streamUpload('/api/scenarios/rr-live/archive', author.auth, archive,
      async () => {});

    assert.equal(answer.status, 201, `the upload answered ${answer.status}`);
    assert.equal(await versionCount('rr-live'), 1);
    assert.match((await row('rr-live')).archive_sha256, /^[0-9a-f]{64}$/);

    const submit = await fetch(`${baseUrl}/api/scenarios/rr-live/submit`, {
      method: 'POST', headers: author.auth,
    });
    assert.equal(submit.status, 200, 'the transition still works for a live key');
    assert.equal((await row('rr-live')).status, 'review');
  });

  await t.test('a key revoked before the request is refused as it always was', async () => {
    const author = await ownedScenario('Revoked Before', 'rr-before');
    await revokeKey(pool, author.id);
    const submit = await fetch(`${baseUrl}/api/scenarios/rr-before/submit`, {
      method: 'POST', headers: author.auth,
    });
    assert.equal(submit.status, 403);
    assert.equal((await row('rr-before')).status, 'draft');
  });
});

// The helper itself, without a request in sight: the contract each write route leans on.
test('F-R1 requireLiveKey passes a live key, refuses a revoked one, ignores the bootstrap', async t => {
  if (skipUnlessDb(t)) return;

  const principalOf = key => ({ role: key.role, keyId: key.id, label: key.label });

  await t.test('a live key passes inside a transaction', async () => {
    const live = await createKey(pool, 'author', 'Guard Live');
    await inTransaction(async db => { await auth.requireLiveKey(db, principalOf(live)); });
  });

  await t.test('a key revoked while the transaction is open is refused by it', async () => {
    // This is the sequence `authenticate` leaves behind: the principal was resolved when
    // the request began, the key was revoked while the work was in flight, and the first
    // statement of the write transaction is what has to notice.
    const live = await createKey(pool, 'author', 'Guard Mid Flight');
    await revokeKey(pool, live.id);
    await assert.rejects(
      () => inTransaction(async db => { await auth.requireLiveKey(db, principalOf(live)); }),
      err => { assert.equal(err.status, 403); assert.equal(err.message, 'Ключ відкликано'); return true; }
    );
  });

  await t.test('the bootstrap principal (no key row) passes', async () => {
    await inTransaction(async db => { await auth.requireLiveKey(db, { role: 'moderator', keyId: null, label: 'admin' }); });
  });
});
