-- 002_manifest_metadata.sql
--
-- Records what the archive's own manifest says about itself.
--
-- The catalog id and the manifest id are independent in practice: catalog rows
-- use slugs, manifests use reverse-domain ids. Storing both makes the drift
-- visible in the admin list instead of invisible inside a ZIP.

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS manifest_id      VARCHAR(200);
ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS manifest_version VARCHAR(50);
