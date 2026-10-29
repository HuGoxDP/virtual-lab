// backend/versions.js
//
// Archive history. Owns `scenario_versions` and the one invariant that ties it to the
// catalog: `scenarios.archive_*` / `scenario_url` always mirror the scenario's `current`
// version, so the public routes never read this table.
//
//   current  - what students get (exactly one, or none for a scenario with no archive yet)
//   pending  - an author's new archive for a PUBLISHED scenario, waiting for a moderator (at most one)
//   archived - everything older; kept until deleted, and every row is a GC reference
//
// Every function takes the caller's transaction client and expects the scenario row to be
// locked (`FOR UPDATE`) by that transaction; the partial unique indexes from migration 010
// are the backstop if one does not.

const storage = require('./storage');
const { httpError } = require('./http-error');

/** Versions kept per scenario, pending and archived included. */
const MAX_VERSIONS = 50;

/** A version as the API shows it. `bytes` is BIGINT, so it is cast (pg would return a string). */
const VERSION_SELECT = `
  SELECT v.id, v.sha256, v.bytes::float8 AS bytes,
         v.manifest_id        AS "manifestId",
         v.manifest_version   AS "manifestVersion",
         v.engine_version     AS "engineVersion",
         v.uploaded_by_key_id AS "uploadedByKeyId",
         k.label              AS "uploadedByLabel",
         v.uploaded_at        AS "uploadedAt",
         v.state, v.checks, v.graded,
         v.test_run           AS "testRun"
    FROM scenario_versions v
    LEFT JOIN publish_keys k ON k.id = v.uploaded_by_key_id
`;

const withUrl = row => ({ ...row, url: storage.publicUrl(row.sha256) });

/** Newest first. */
async function listVersions(db, scenarioId) {
  const { rows } = await db.query(
    `${VERSION_SELECT} WHERE v.scenario_id = $1 ORDER BY v.uploaded_at DESC, v.id DESC`, [scenarioId]
  );
  return rows.map(withUrl);
}

/** The version `vid` of `scenarioId`; 404 when there is none - including a real version of another scenario. */
async function getVersion(db, scenarioId, vid) {
  const { rows } = await db.query(`${VERSION_SELECT} WHERE v.id = $1 AND v.scenario_id = $2`, [vid, scenarioId]);
  if (!rows[0]) throw httpError(404, 'Версію не знайдено');
  return withUrl(rows[0]);
}

/** SERIAL ids are 32-bit; anything else cannot exist and must not reach the query as an overflow. */
const VERSION_ID = /^[1-9][0-9]{0,8}$/;

/** `getVersion` for an id that came off a URL: a malformed one is a 404, never a query error. */
async function getVersionByParam(db, scenarioId, rawVid) {
  if (!VERSION_ID.test(rawVid)) throw httpError(404, 'Версію не знайдено');
  return getVersion(db, scenarioId, Number(rawVid));
}

/**
 * Repoints the catalog row at `version` and records its integrity metadata. `graded` mirrors the
 * version too: the LTI grade passback must follow the archive students run, so an upload that
 * is still pending, or any other version that is not current, never reaches `scenarios.graded`.
 */
async function pointScenarioAt(db, scenarioId, version) {
  await db.query(`
    UPDATE scenarios
       SET scenario_url            = $1,
           archive_sha256          = $2,
           archive_bytes           = $3,
           manifest_id             = $4,
           manifest_version        = $5,
           manifest_engine_version = $6,
           graded                  = $8,
           storage_kind            = 'local',
           updated_at              = NOW()
     WHERE id = $7
  `, [
    storage.publicUrl(version.sha256), version.sha256, version.bytes,
    version.manifestId, version.manifestVersion, version.engineVersion, scenarioId, version.graded === true,
  ]);
}

/**
 * Stores an uploaded archive in the history according to the scenario's status and the
 * uploader's role, and returns `{ version, state, changed }`.
 *
 *   draft / rejected        -> new current; the old one is archived; a pending row is deleted
 *   review                  -> 409 (withdraw first, so a moderator never reviews bytes that then change)
 *   published, moderator    -> new current (an existing pending row stays)
 *   published, author       -> pending, replacing any earlier pending row
 *
 * Bytes identical to the current version (or, for a pending upload, to the pending one) change
 * nothing: `changed` is false and the existing row is returned. More than MAX_VERSIONS -> 409.
 *
 * @param scenario  the locked row: `{ id, status }`
 * @param stored    `storage.commitArchive`'s result: `{ sha256, bytes }`
 * @param manifest  the validated manifest
 * @param checks    `archive-checks` result for the new row (null: none recorded)
 */
async function installUpload(db, scenario, principal, stored, manifest, checks = null) {
  if (scenario.status === 'review') throw httpError(409, 'Сценарій на перевірці: відкличте з перевірки, щоб завантажити новий архів');

  const asPending = scenario.status === 'published' && principal.role === 'author';
  const { rows: existing } = await db.query(
    'SELECT id, sha256, state FROM scenario_versions WHERE scenario_id = $1', [scenario.id]
  );
  const current = existing.find(v => v.state === 'current');
  const pending = existing.find(v => v.state === 'pending');

  const same = [current, asPending ? pending : null].find(v => v?.sha256 === stored.sha256);
  if (same) return { version: await getVersion(db, scenario.id, same.id), state: same.state, changed: false };

  // A moderator's upload to a published scenario leaves an author's pending proposal alone.
  const dropsPending = pending && !(scenario.status === 'published' && !asPending);
  if (existing.length - (dropsPending ? 1 : 0) >= MAX_VERSIONS) {
    throw httpError(409, `Забагато версій: максимум ${MAX_VERSIONS} на сценарій, видаліть непотрібні`);
  }
  if (dropsPending) await db.query('DELETE FROM scenario_versions WHERE id = $1', [pending.id]);
  if (!asPending) {
    await db.query("UPDATE scenario_versions SET state = 'archived' WHERE scenario_id = $1 AND state = 'current'", [scenario.id]);
  }

  const state = asPending ? 'pending' : 'current';
  const { rows: [inserted] } = await db.query(`
    INSERT INTO scenario_versions
      (scenario_id, sha256, bytes, manifest_id, manifest_version, engine_version, uploaded_by_key_id, state, checks, graded)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
    RETURNING id
  `, [
    scenario.id, stored.sha256, stored.bytes,
    manifest?.id ?? null, manifest?.version ?? null,
    // Which engine build the scenario was compiled against - null for archives
    // predating ScenarioCreator stamping it.
    manifest?.engineVersion ?? null,
    principal.keyId, state, checks && JSON.stringify(checks),
    // Only an explicit `graded: true` grades; a manifest without the key is not graded.
    manifest?.graded === true,
  ]);

  const version = await getVersion(db, scenario.id, inserted.id);
  if (!asPending) await pointScenarioAt(db, scenario.id, version);
  return { version, state, changed: true };
}

/** Makes `version` (pending or archived) the current one: accept and restore are this. */
async function promote(db, scenarioId, version) {
  await db.query("UPDATE scenario_versions SET state = 'archived' WHERE scenario_id = $1 AND state = 'current'", [scenarioId]);
  await db.query("UPDATE scenario_versions SET state = 'current' WHERE id = $1", [version.id]);
  await pointScenarioAt(db, scenarioId, version);
}

/** Deletes a version row. Its object is left to GC (collectible once nothing references it). */
async function removeVersion(db, versionId) {
  await db.query('DELETE FROM scenario_versions WHERE id = $1', [versionId]);
}

module.exports = { MAX_VERSIONS, listVersions, getVersion, getVersionByParam, installUpload, promote, removeVersion };
