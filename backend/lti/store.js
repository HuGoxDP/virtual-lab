// backend/lti/store.js
//
// Every SQL statement of the LTI module. Handlers talk to this, never to `pg`.

/** @param {import('pg').Pool} pool */
function createStore(pool) {
  const REGISTRATION_COLUMNS = `
    issuer, client_id AS "clientId", deployment_ids AS "deploymentIds",
    auth_login_url AS "authLoginUrl", auth_token_url AS "authTokenUrl", jwks_uri AS "jwksUri"`;

  return {
    /** Inserts or refreshes the registration for (issuer, clientId). */
    async saveRegistration(r) {
      await pool.query(`
        INSERT INTO lti_registrations (issuer, client_id, deployment_ids, auth_login_url, auth_token_url, jwks_uri)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (issuer, client_id) DO UPDATE SET
          deployment_ids = EXCLUDED.deployment_ids, auth_login_url = EXCLUDED.auth_login_url,
          auth_token_url = EXCLUDED.auth_token_url, jwks_uri = EXCLUDED.jwks_uri, updated_at = NOW()
      `, [r.issuer, r.clientId, r.deploymentIds, r.authLoginUrl, r.authTokenUrl, r.jwksUri]);
    },

    async getRegistration(issuer, clientId) {
      const { rows } = await pool.query(
        `SELECT ${REGISTRATION_COLUMNS} FROM lti_registrations WHERE issuer = $1 AND client_id = $2`,
        [issuer, clientId]);
      return rows[0] || null;
    },

    async listRegistrations(issuer) {
      const { rows } = await pool.query(
        `SELECT ${REGISTRATION_COLUMNS} FROM lti_registrations WHERE issuer = $1 ORDER BY created_at`,
        [issuer]);
      return rows;
    },

    async saveState(s, ttlSeconds) {
      await pool.query(`
        INSERT INTO lti_states (state, nonce, issuer, client_id, target_link_uri, expires_at)
        VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6))
      `, [s.state, s.nonce, s.issuer, s.clientId, s.targetLinkUri, ttlSeconds]);
    },

    /** Atomically takes the state: a second call (replay) or an expired one returns null. */
    async consumeState(state) {
      const { rows } = await pool.query(`
        DELETE FROM lti_states WHERE state = $1 AND expires_at > NOW()
        RETURNING nonce, issuer, client_id AS "clientId", target_link_uri AS "targetLinkUri"
      `, [state]);
      return rows[0] || null;
    },

    async saveSession(idHash, s, ttlSeconds) {
      await pool.query(`
        INSERT INTO lti_sessions
          (id, issuer, client_id, deployment_id, sub, role, context_id, resource_link_id, lineitem_url,
           scenario_id, message_type, deep_link_return_url, deep_link_data, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + make_interval(secs => $14))
      `, [idHash, s.issuer, s.clientId, s.deploymentId, s.sub, s.role, s.contextId, s.resourceLinkId,
          s.lineitemUrl, s.scenarioId, s.messageType, s.deepLinkReturnUrl, s.deepLinkData, ttlSeconds]);
    },

    async findSession(idHash) {
      const { rows } = await pool.query(`
        SELECT id, issuer, client_id AS "clientId", deployment_id AS "deploymentId", sub, role,
               context_id AS "contextId", resource_link_id AS "resourceLinkId", lineitem_url AS "lineitemUrl",
               scenario_id AS "scenarioId", message_type AS "messageType",
               deep_link_return_url AS "deepLinkReturnUrl", deep_link_data AS "deepLinkData"
        FROM lti_sessions WHERE id = $1 AND expires_at > NOW()
      `, [idHash]);
      return rows[0] || null;
    },

    /** Housekeeping: drops expired states and sessions. Called opportunistically on login. */
    async deleteExpired() {
      await pool.query('DELETE FROM lti_states WHERE expires_at <= NOW()');
      await pool.query('DELETE FROM lti_sessions WHERE expires_at <= NOW()');
    },
  };
}

module.exports = { createStore };
