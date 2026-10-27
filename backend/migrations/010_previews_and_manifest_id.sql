-- 010_previews_and_manifest_id.sql
--
-- Catalog management API (Nocturne release 2, phase 4).
--
-- 1. Cover images are now uploaded to the platform's own preview store (`/previews/<sha256>.png|jpg`),
--    and the CSP's `img-src` drops `https:`. A row whose `image_url` points off-origin
--    (`http://`, `https://`, `//host/...`, any `scheme://`) would then show a broken image, so it is
--    cleared to '' and each one is listed in the migration log (`[MIGRATE] ...`) so an owner can
--    upload a preview in its place. Same-origin paths (`/assets/...`, `/previews/...`) are kept.
--    Idempotent: a second run finds nothing to clear.
--
-- 2. `scenarios.manifest_id` was VARCHAR(200) while `scenario_versions.manifest_id` is VARCHAR(255):
--    accepting a pending version could fail with a 500 on an id between the two. Widening the
--    scenarios column makes the limit one number (the archive validator enforces it too); widening
--    never loses data and re-running it is a no-op.

DO $$
DECLARE
    cleared RECORD;
BEGIN
    FOR cleared IN
        SELECT id, image_url FROM scenarios
         WHERE image_url ~* '^([a-z][a-z0-9+.-]*:)?//'
         ORDER BY id
    LOOP
        RAISE NOTICE 'cleared external imageUrl of scenario %: %', cleared.id, cleared.image_url;
    END LOOP;

    UPDATE scenarios SET image_url = '' WHERE image_url ~* '^([a-z][a-z0-9+.-]*:)?//';
END $$;

ALTER TABLE scenarios ALTER COLUMN manifest_id TYPE VARCHAR(255);
