-- 001_archive_storage.sql
--
-- Content-addressed archive storage.
--
-- `db/init.sql` only ever runs on an empty volume, so every schema change from
-- here on lives in `backend/migrations/` and is applied by the backend at
-- startup (see `backend/migrations.js`).
-- Statements must be idempotent: a fresh volume runs init.sql *and* this file.

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS archive_sha256 CHAR(64);
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS archive_bytes  BIGINT;

-- Where the archive lives: 'drive' = external Google Drive link (legacy),
-- 'local' = /scenarios/<sha256>.zip served by nginx from the archives volume.
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS storage_kind VARCHAR(16) NOT NULL DEFAULT 'drive';

UPDATE scenarios
   SET storage_kind = 'local'
 WHERE scenario_url LIKE '/scenarios/%'
   AND storage_kind <> 'local';

-- The catalog query filters on this column on every page load.
CREATE INDEX IF NOT EXISTS idx_scenarios_published ON scenarios(is_published);

-- Same content uploaded twice must resolve to the same object.
CREATE INDEX IF NOT EXISTS idx_scenarios_archive_sha256 ON scenarios(archive_sha256);
