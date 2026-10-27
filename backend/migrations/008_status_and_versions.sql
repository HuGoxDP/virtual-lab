-- 008_status_and_versions.sql
--
-- Publishing workflow and archive history (Nocturne release 2, phase 3).
--
-- `scenarios.status` replaces the boolean `is_published`:
--   draft -> review -> published | rejected   (unpublish returns to draft)
-- `moderator_note` carries a rejection's reason; `submitted_at` when it entered review.
-- `is_published` is dropped by 009, in its own file, because dropping it is the one
-- irreversible step. Until then both exist; this migration backfills `status` from it.
--
-- `scenario_versions` is the archive history. Exactly one `current` row per scenario
-- is what students get (it mirrors `scenarios.archive_*`); at most one `pending` row is
-- an author's new archive for a published scenario, waiting for a moderator; every older
-- one is `archived`. A version row is a GC reference until it is deleted. It cascades
-- with its scenario, so deleting a scenario frees every object only it referenced.
--
-- Idempotent: every statement tolerates a re-run, including after 009 has dropped
-- `is_published` (the backfill then has nothing to read, and nothing to do).

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS status         VARCHAR(20);
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS moderator_note TEXT;
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS submitted_at   TIMESTAMPTZ;

-- The column is nullable, so only a literal TRUE is published (NULL reads as draft).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'scenarios' AND column_name = 'is_published') THEN
        UPDATE scenarios
           SET status = CASE WHEN is_published IS TRUE THEN 'published' ELSE 'draft' END
         WHERE status IS NULL;
    END IF;
END $$;

UPDATE scenarios SET status = 'draft' WHERE status IS NULL;

ALTER TABLE scenarios ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE scenarios ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scenarios_status_check') THEN
        ALTER TABLE scenarios ADD CONSTRAINT scenarios_status_check
            CHECK (status IN ('draft', 'review', 'published', 'rejected'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scenarios_status ON scenarios (status);

CREATE TABLE IF NOT EXISTS scenario_versions (
    id                  SERIAL        PRIMARY KEY,
    scenario_id         VARCHAR(100)  NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
    sha256              CHAR(64)      NOT NULL,
    bytes               BIGINT        NOT NULL,
    manifest_id         VARCHAR(255),
    manifest_version    VARCHAR(50),
    engine_version      VARCHAR(100),
    uploaded_by_key_id  INTEGER       REFERENCES publish_keys(id),
    uploaded_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    state               VARCHAR(10)   NOT NULL CHECK (state IN ('current', 'pending', 'archived')),
    checks              JSONB,
    test_run            JSONB
);

-- The backstops for the invariants the routes keep under a row lock.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scenario_versions_one_current
    ON scenario_versions (scenario_id) WHERE state = 'current';
CREATE UNIQUE INDEX IF NOT EXISTS idx_scenario_versions_one_pending
    ON scenario_versions (scenario_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_scenario_versions_sha ON scenario_versions (sha256);
CREATE INDEX IF NOT EXISTS idx_scenario_versions_scenario ON scenario_versions (scenario_id, uploaded_at DESC);

-- Every scenario that already has an archive gets it as its one `current` version.
-- Rows whose archive is streamed only (a manifest URL, no archive) get none.
INSERT INTO scenario_versions
    (scenario_id, sha256, bytes, manifest_id, manifest_version, engine_version, uploaded_at, state)
SELECT s.id, s.archive_sha256, COALESCE(s.archive_bytes, 0), s.manifest_id, s.manifest_version,
       s.manifest_engine_version, COALESCE(s.updated_at, s.created_at, NOW()), 'current'
  FROM scenarios s
 WHERE s.archive_sha256 IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM scenario_versions v WHERE v.scenario_id = s.id);
