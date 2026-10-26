-- 006_categories_and_features.sql
--
-- Categories become a first-class table (icon, order, visibility) and a
-- scenario gains the "Що всередині" list.
--
-- `scenarios.category` / `category_label` stay as they are: no foreign key on
-- purpose, so a scenario whose slug has no category row still lists (it just has
-- no chip). `categories.label` is canonical in responses; the scenario's own
-- `category_label` is only the fallback.
--
-- `is_visible` is always true in release 1; it exists now so the admin release
-- adds no column for it.

CREATE TABLE IF NOT EXISTS categories (
    slug        VARCHAR(50)   PRIMARY KEY,
    label       VARCHAR(100)  NOT NULL,
    icon        VARCHAR(40)   NOT NULL DEFAULT 'folder',
    sort_order  INTEGER       NOT NULL DEFAULT 0,
    is_visible  BOOLEAN       NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE scenarios ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Seed one row per slug in use; order = label order (Ukrainian collation) x 10.
-- Re-running is a no-op: existing slugs are left untouched.
INSERT INTO categories (slug, label, icon, sort_order)
SELECT slug,
       label,
       CASE slug
         WHEN 'physics'   THEN 'lightning'
         WHEN 'biology'   THEN 'dna'
         WHEN 'chemistry' THEN 'flask'
         WHEN 'history'   THEN 'bank'
         WHEN 'astronomy' THEN 'planet'
         WHEN 'test'      THEN 'cube'
         ELSE 'folder'
       END,
       (ROW_NUMBER() OVER (ORDER BY label COLLATE "uk-x-icu", slug))::int * 10
  FROM (
    SELECT category AS slug, MIN(category_label) AS label
      FROM scenarios
     GROUP BY category
  ) distinct_categories
ON CONFLICT (slug) DO NOTHING;
