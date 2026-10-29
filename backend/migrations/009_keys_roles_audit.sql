-- 009_keys_roles_audit.sql
--
-- Personal publish keys with a role, scenario ownership, and an action journal
-- (Nocturne release 2, phase 2).
--
-- `publish_keys` replaces "one shared ADMIN_TOKEN" as the way to write to the
-- catalog: a key per person, revocable on its own, carrying a role. Only the
-- SHA-256 of a token is stored (the token is high-entropy, so a fast hash is
-- the right tool); the token itself is shown once, when it is issued.
-- `ADMIN_TOKEN` stays as the bootstrap moderator and has no row here.
--
-- `scenarios.owner_key_id` says whose scenario it is. Existing rows have no
-- owner (NULL): only moderators edit them. Keys are revoked, never deleted, so
-- the reference is a plain foreign key.
--
-- `audit_events.scenario_id` has NO foreign key on purpose, like
-- `scenario_sessions` (003): the history of a deleted scenario must survive it.
-- `actor_label` is copied at write time so a row still reads after its key is
-- renamed or gone.

CREATE TABLE IF NOT EXISTS publish_keys (
    id            SERIAL        PRIMARY KEY,
    label         VARCHAR(100)  NOT NULL,
    role          VARCHAR(20)   NOT NULL CHECK (role IN ('author', 'moderator')),
    token_hash    CHAR(64)      NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);

ALTER TABLE scenarios
    ADD COLUMN IF NOT EXISTS owner_key_id INTEGER REFERENCES publish_keys(id);

CREATE INDEX IF NOT EXISTS idx_scenarios_owner_key ON scenarios (owner_key_id);

CREATE TABLE IF NOT EXISTS audit_events (
    id            BIGSERIAL     PRIMARY KEY,
    scenario_id   VARCHAR(100),
    actor_key_id  INTEGER,
    actor_label   VARCHAR(100)  NOT NULL,
    action        VARCHAR(50)   NOT NULL,
    details       JSONB         NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_scenario ON audit_events (scenario_id, created_at DESC);
