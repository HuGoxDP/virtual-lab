-- 009_drop_is_published.sql
--
-- Drops `scenarios.is_published`: `status` (008) is the only source of truth now, and two
-- columns that must agree would drift. THE POINT OF NO RETURN: take a `pg_dump` before
-- deploying. Down-migration (versions and pending state are not recoverable by it):
--
--   ALTER TABLE scenarios ADD COLUMN is_published BOOLEAN DEFAULT true;
--   UPDATE scenarios SET is_published = (status = 'published');
--
-- Idempotent: DROP ... IF EXISTS. The index goes with the column; named for clarity.

DROP INDEX IF EXISTS idx_scenarios_published;
ALTER TABLE scenarios DROP COLUMN IF EXISTS is_published;
