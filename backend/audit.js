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

module.exports = { record };
