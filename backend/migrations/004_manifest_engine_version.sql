-- 004_manifest_engine_version.sql
--
-- Records which engine build an archive was compiled against.
--
-- The manifests ScenarioCreator emits now carry a real `engineVersion` — a
-- stamped `0.1.0-local.<timestamp>`, not a hand-maintained literal — so this is
-- finally worth storing. Without it, "was this scenario built against the engine
-- we are actually shipping?" is only answerable by unzipping the archive.
--
-- The question is not hypothetical: at the time this column was added, every
-- archive in the catalog was built against 0.1.0-local.1786479071411 while the
-- installed bundle was 0.1.0-local.1786569427449. That is normally harmless, and
-- exactly the kind of thing that should be visible rather than inferred.
--
-- Pairs with the engine's own BuildInfo, which the viewer shows under ?diag=1:
-- one says what the scenario was built against, the other what is running.

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS manifest_engine_version VARCHAR(100);
