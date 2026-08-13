-- 005_scenario_manifest.sql
--
-- Where a scenario's streaming manifest lives, when it has one.
--
-- A scenario can be delivered two ways: as one ZIP (`scenario_url`) or as a
-- manifest of individually-fetched scripts and assets (`manifest_url`, served
-- from the per-asset store under /a/). The two are not exclusive — the same
-- content is published both ways — so this is an additional column rather than
-- another `storage_kind`.
--
-- Deliberately NOT a `scenario_assets` table yet. The manifest already lists
-- every asset with its priority and LOD ladder, and it is served statically, so
-- a table duplicating it would have no reader. Reference counting for garbage
-- collection (R5) is the first thing that will actually need one; design it then,
-- against a shape that is now known rather than guessed.

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS manifest_url VARCHAR(300);
