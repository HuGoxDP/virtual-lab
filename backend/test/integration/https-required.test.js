// backend/test/integration/https-required.test.js
//
// B6 phase 2 (DW-2.1, DW-2.2): with REQUIRE_HTTPS on, a presented credential
// is accepted only over https and answered 403 https_required over http —
// before anything is resolved, without touching the last-used stamp and
// without consuming the auth-failure budget. With it off, nothing changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, pool } = require('../../server');
const { failedAuth } = require('../../rate-limits');
const { isAvailable, prepareSchema, truncateAll } = require('../helpers/db');
const { createKey, sha256Hex } = require('../helpers/keys');
const { httpsRequired } = require('../../auth');

const original = process.env.REQUIRE_HTTPS;

let available = false;

test.before(async () => {
  available = await isAvailable(pool);
  if (!available) return;
  await prepareSchema(pool);
  await truncateAll(pool);
});

test.beforeEach(() => failedAuth.reset());

test.after(async () => {
  if (original === undefined) delete process.env.REQUIRE_HTTPS;
  else process.env.REQUIRE_HTTPS = original;
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

test('B6.2 httpsRequired reads the literal true/1 and nothing else', () => {
  const saved = process.env.REQUIRE_HTTPS;
  try {
    for (const on of ['true', '1']) {
      process.env.REQUIRE_HTTPS = on;
      assert.equal(httpsRequired(), true, on);
    }
    for (const off of [undefined, '', 'false', 'TRUE', 'yes', '0']) {
      process.env.REQUIRE_HTTPS = off;
      assert.equal(httpsRequired(), false, String(off));
    }
  } finally {
    if (saved === undefined) delete process.env.REQUIRE_HTTPS;
    else process.env.REQUIRE_HTTPS = saved;
  }
});

test('B6.2 with the switch on, a credential over http is refused before anything is resolved', async t => {
  if (skipUnlessDb(t)) return;

  const key = await createKey(pool, 'moderator', 'HTTPS Moderator');

  await t.test('DW-2.1: http + a valid key is 403 https_required without a last-used stamp', async () => {
    process.env.REQUIRE_HTTPS = 'true';

    const res = await request(app).get('/api/auth/me').set(key.auth)
      .set('X-Forwarded-Proto', 'http').expect(403);
    assert.equal(res.body.code, 'https_required');

    const { rows } = await pool.query('SELECT last_used_at FROM publish_keys WHERE id = $1', [key.id]);
    assert.equal(rows[0].last_used_at, null, 'the key was not resolved, so nothing was stamped');
  });

  await t.test('DW-2.1: the refusal does not consume the auth-failure budget', async () => {
    // 31 refusals from one address: every one 403, never 429.
    for (let i = 0; i < 31; i++) {
      const res = await request(app).get('/api/auth/me').set(key.auth)
        .set('X-Forwarded-Proto', 'http');
      assert.equal(res.status, 403, `call ${i + 1}`);
    }
  });

  await t.test('DW-2.2: the same key over https is 200', async () => {
    const res = await request(app).get('/api/auth/me').set(key.auth)
      .set('X-Forwarded-Proto', 'https').expect(200);
    assert.equal(res.body.role, 'moderator');
  });

  await t.test('DW-2.2: with the switch unset, http is answered (today\'s behaviour)', async () => {
    delete process.env.REQUIRE_HTTPS;
    await request(app).get('/api/auth/me').set(key.auth).expect(200);
  });

  await t.test('DW-2.2: a public route keeps working over http with the switch on', async () => {
    process.env.REQUIRE_HTTPS = 'true';
    await request(app).get('/api/catalog').expect(200);
  });

  await t.test('optionalAuthenticate carries on anonymously over http', async () => {
    process.env.REQUIRE_HTTPS = 'true';
    const res = await request(app).get('/api/catalog?limit=1').expect(200);
    assert.ok(res.body);
  });
});
