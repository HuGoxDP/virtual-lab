-- 007_lti.sql
--
-- LTI 1.3 tool support (Moodle and other platforms). Three tables, all additive:
--
--   lti_registrations  one row per (platform issuer, client id) the tool was registered with, written by
--                      Dynamic Registration. `deployment_ids` is the list the launch must match.
--   lti_states         one-time OIDC login states (state + nonce). Consumed by the launch POST, so a replayed
--                      launch or a replayed nonce finds nothing; rows also expire on their own.
--   lti_sessions       the server-side session behind the `lti_session` cookie. `id` is the sha256 of the cookie
--                      token, never the token itself.
--
-- Privacy: the platform stores no grades, attempts, names or e-mails. A session holds only the opaque LTI
-- `sub`, the role, the context / resource-link ids and the AGS line-item URL. Do not add personal columns here.
--
-- No foreign keys on purpose: a session must survive the registration being re-registered (upsert), and
-- `scenario_id` is a hint from the platform, not a reference the catalog guarantees.

CREATE TABLE IF NOT EXISTS lti_registrations (
    issuer          TEXT         NOT NULL,
    client_id       TEXT         NOT NULL,
    deployment_ids  TEXT[]       NOT NULL DEFAULT '{}',
    auth_login_url  TEXT         NOT NULL,
    auth_token_url  TEXT         NOT NULL,
    jwks_uri        TEXT         NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (issuer, client_id)
);

CREATE TABLE IF NOT EXISTS lti_states (
    state            TEXT         PRIMARY KEY,
    nonce            TEXT         NOT NULL,
    issuer           TEXT         NOT NULL,
    client_id        TEXT         NOT NULL,
    target_link_uri  TEXT         NOT NULL,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lti_states_expires ON lti_states (expires_at);

CREATE TABLE IF NOT EXISTS lti_sessions (
    id                    TEXT         PRIMARY KEY,
    issuer                TEXT         NOT NULL,
    client_id             TEXT         NOT NULL,
    deployment_id         TEXT         NOT NULL,
    sub                   TEXT         NOT NULL,
    role                  TEXT         NOT NULL CHECK (role IN ('learner', 'instructor')),
    context_id            TEXT,
    resource_link_id      TEXT,
    lineitem_url          TEXT,
    scenario_id           VARCHAR(100),
    message_type          TEXT         NOT NULL CHECK (message_type IN ('resource', 'deep-link')),
    deep_link_return_url  TEXT,
    deep_link_data        TEXT,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at            TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lti_sessions_expires ON lti_sessions (expires_at);
