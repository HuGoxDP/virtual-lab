// backend/routes/versions.js
//
// A scenario's archive history: list, and the moderator's and owner's decisions on it.
//
//   GET    /api/scenarios/:id/versions                  owner or moderator
//   POST   /api/scenarios/:id/versions/:vid/accept      moderator   pending  -> current
//   POST   /api/scenarios/:id/versions/:vid/reject      moderator   pending  -> row deleted
//   POST   /api/scenarios/:id/versions/:vid/restore     moderator   archived -> current
//   DELETE /api/scenarios/:id/versions/:vid             archived: moderator; pending: owner or moderator;
//                                                       current: never (409)
//
// A version id that belongs to another scenario is a 404, not a 403: the route never
// confirms it exists. Deleting a row leaves its object to GC.

const express = require('express');

const { pool, inTransaction } = require('../db');
const { authorize, canEditScenario } = require('../auth');
const audit = require('../audit');
const { httpError, sendError } = require('../http-error');
const versions = require('../versions');

const router = express.Router();

/** SERIAL ids are 32-bit; anything else cannot exist and must not reach the query as an overflow. */
const VERSION_ID = /^[1-9][0-9]{0,8}$/;

/** Locks the scenario row and returns it, or throws 404. */
async function lockScenario(db, id) {
  const { rows } = await db.query('SELECT id, owner_key_id, status FROM scenarios WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw httpError(404, 'Сценарій не знайдено');
  return rows[0];
}

/** Version `vid` of scenario `id`; 404 for a malformed id, a missing one, or one of another scenario. */
async function loadVersion(db, id, vid) {
  if (!VERSION_ID.test(vid)) throw httpError(404, 'Версію не знайдено');
  return versions.getVersion(db, id, Number(vid));
}

const requireState = (version, state, message) => {
  if (version.state !== state) throw httpError(409, message);
};

const details = version => ({ versionId: version.id, sha256: version.sha256, state: version.state });

router.get('/api/scenarios/:id/versions', authorize('author'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT owner_key_id FROM scenarios WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw httpError(404, 'Сценарій не знайдено');
    if (!canEditScenario(req.principal, rows[0])) throw httpError(403, 'Це не ваш сценарій');

    res.json({ versions: await versions.listVersions(pool, req.params.id) });
  } catch (err) {
    sendError(res, err, 'GET /api/scenarios/:id/versions');
  }
});

// accept / reject / restore: a moderator acts on one version in one transaction.
const DECISIONS = {
  accept: {
    run: async (db, id, version) => {
      requireState(version, 'pending', 'Прийняти можна лише версію, що очікує розгляду');
      await versions.promote(db, id, version);
    },
  },
  reject: {
    run: async (db, id, version) => {
      requireState(version, 'pending', 'Відхилити можна лише версію, що очікує розгляду');
      await versions.removeVersion(db, version.id);
    },
  },
  restore: {
    run: async (db, id, version) => {
      requireState(version, 'archived', 'Відновити можна лише архівну версію');
      await versions.promote(db, id, version);
    },
  },
};

for (const [action, { run }] of Object.entries(DECISIONS)) {
  router.post(`/api/scenarios/:id/versions/:vid/${action}`, authorize('moderator'), async (req, res) => {
    try {
      await inTransaction(async db => {
        await lockScenario(db, req.params.id);
        const version = await loadVersion(db, req.params.id, req.params.vid);
        await run(db, req.params.id, version);
        await audit.record(db, req.principal, `version.${action}`, req.params.id, details(version));
      });
      res.json({ message: 'Готово', id: req.params.id, versionId: Number(req.params.vid) });
    } catch (err) {
      sendError(res, err, `POST /api/scenarios/:id/versions/:vid/${action}`);
    }
  });
}

router.delete('/api/scenarios/:id/versions/:vid', authorize('author'), async (req, res) => {
  try {
    await inTransaction(async db => {
      const scenario = await lockScenario(db, req.params.id);
      if (!canEditScenario(req.principal, scenario)) throw httpError(403, 'Це не ваш сценарій');
      const version = await loadVersion(db, req.params.id, req.params.vid);

      if (version.state === 'current') throw httpError(409, 'Поточну версію видалити не можна: спершу відновіть іншу');
      // An author withdraws their own pending proposal; archived history is a moderator's.
      if (version.state === 'archived' && req.principal.role !== 'moderator') {
        throw httpError(403, 'Недостатньо прав');
      }

      await versions.removeVersion(db, version.id);
      await audit.record(db, req.principal, 'version.delete', req.params.id, details(version));
    });
    res.json({ message: 'Версію видалено', id: req.params.id, versionId: Number(req.params.vid) });
  } catch (err) {
    sendError(res, err, 'DELETE /api/scenarios/:id/versions/:vid');
  }
});

module.exports = { router };
