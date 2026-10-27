-- 008_scenario_graded.sql
--
-- `graded` marks a scenario that reports a score (`{ score, completed }`, manifest key `graded: true`).
-- Set at archive upload from the manifest, never by hand. Used only by the LTI grade passback: a graded
-- scenario sends the score the student reached, any other sends 1.0 on completion. The platform stores
-- no grades itself.

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS graded BOOLEAN NOT NULL DEFAULT false;
