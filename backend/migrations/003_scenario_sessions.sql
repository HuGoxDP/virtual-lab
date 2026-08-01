-- 003_scenario_sessions.sql
--
-- Anonymous "a scenario was opened" event log.
--
-- Deliberately not a learning-domain model: no users, no roles, no courses.
-- Enough to say how often each scenario is opened and for how long, which is
-- what the deployment write-up needs.
--
-- No foreign key to `scenarios` on purpose: deleting a scenario must not erase
-- the record that it was used. `scenario_id` is a plain historical value.

CREATE TABLE IF NOT EXISTS scenario_sessions (
    id           BIGSERIAL     PRIMARY KEY,
    scenario_id  VARCHAR(100)  NOT NULL,
    -- Random per-browser id from localStorage; not linked to any person.
    client_id    UUID,
    started_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    ended_at     TIMESTAMPTZ,
    duration_ms  INTEGER,
    user_agent   VARCHAR(300)
);

CREATE INDEX IF NOT EXISTS idx_sessions_scenario ON scenario_sessions(scenario_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started  ON scenario_sessions(started_at);

-- Only open sessions are ever updated, so keep that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_sessions_open ON scenario_sessions(id) WHERE ended_at IS NULL;
