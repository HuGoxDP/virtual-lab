-- 013_scenario_versions_graded.sql
--
-- `graded` (008_scenario_graded) says a scenario reports a score, and the LTI grade passback reads
-- `scenarios.graded`. Since archives became versions (010) a new upload is not necessarily what
-- students run: an author's upload to a published scenario waits as `pending`, and restoring or
-- accepting a version changes which one is current. So the flag belongs to the VERSION (it comes
-- from that archive's manifest) and `scenarios.graded` mirrors the CURRENT version, like
-- `archive_*` does (versions.js `pointScenarioAt`).
--
-- Backfill: the current version of each scenario takes `scenarios.graded`, which was set from that
-- very archive's manifest by the old upload path. Archived/pending versions keep the default
-- (false): their manifests are not re-read here, and the flag only matters once one becomes current,
-- at which point it is read from the version row - so a restore of such an old version grades as
-- not-graded until it is re-uploaded. (No deployed database has any: versions arrived with 010.)
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the backfill only ever sets TRUE on a current version
-- whose scenario is graded, which a re-run reproduces exactly.

ALTER TABLE scenario_versions ADD COLUMN IF NOT EXISTS graded BOOLEAN NOT NULL DEFAULT false;

UPDATE scenario_versions v
   SET graded = true
  FROM scenarios s
 WHERE v.scenario_id = s.id
   AND v.state = 'current'
   AND s.graded
   AND NOT v.graded;
