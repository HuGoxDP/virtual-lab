// backend/audit.js
//
// The action journal. `record` takes the caller's transaction client, so an
// event commits with the change it describes and rolls back with it.

/**
 * Appends one `audit_events` row.
 *
 * @param {import('pg').PoolClient} client  the request's own transaction
 * @param {{keyId: number|null, label: string}} principal
 * @param {string} action  e.g. `scenario.create`, `key.revoke`
 * @param {string|null} [scenarioId]  not a foreign key: history survives deletion
 * @param {object} [details]  JSON-serialisable; never put a token in it
 */
async function record(client, principal, action, scenarioId = null, details = {}) {
  await client.query(
    `INSERT INTO audit_events (scenario_id, actor_key_id, actor_label, action, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [scenarioId, principal.keyId, principal.label, action, JSON.stringify(details)]
  );
}

/**
 * Journal rows as the API shows them, newest first:
 * `{ id, scenarioId, scenarioTitle, actorLabel, action, details, createdAt }`.
 * `scenarioTitle` is null for an event with no scenario or one whose scenario is deleted.
 *
 * B6 (DW-4.2): a scenario id is not unique over time — a moderator may delete a row and an
 * author may create the same id again. With `sinceScenarioCreated` only the live row's era is
 * returned, so the new owner does not read the previous owner's history through their own id.
 * A moderator passes it false and keeps the full history, which they need to administer.
 *
 * @param {object} filter
 * @param {string|null} [filter.scenarioId]   only this scenario's events
 * @param {number|null} [filter.ownerKeyId]   only events of scenarios this key owns (an author's view)
 * @param {number} filter.limit
 * @param {boolean} [filter.sinceScenarioCreated]  only events newer than the live row's creation
 */
async function listActivity(db, { scenarioId = null, ownerKeyId = null, limit, sinceScenarioCreated = false }) {
  const era = sinceScenarioCreated ? ' AND a.created_at >= s.created_at' : '';
  const { rows } = await db.query(`
    SELECT a.id::float8 AS id, a.scenario_id AS "scenarioId", s.title AS "scenarioTitle",
           a.actor_label AS "actorLabel", a.action, a.details, a.created_at AS "createdAt"
      FROM audit_events a
      LEFT JOIN scenarios s ON s.id = a.scenario_id
     WHERE ($1::text IS NULL OR a.scenario_id = $1)
       AND ($2::int IS NULL OR s.owner_key_id = $2)${era}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $3
  `, [scenarioId, ownerKeyId, limit]);
  return rows;
}

module.exports = { record, listActivity };
