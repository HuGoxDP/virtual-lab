// backend/test/helpers/db.js
//
// Integration tests run against a real Postgres — the queries under test use
// ILIKE ... ESCAPE, PERCENTILE_CONT and partial indexes, none of which a mock
// would exercise honestly.
//
// Point them at a throwaway database:
//   DB_HOST=localhost DB_NAME=virtual_lab_test npm test

const { runMigrations } = require('../../migrations');

/** True when the configured database is reachable. */
async function isAvailable(pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Applies init.sql's baseline plus every migration. */
async function prepareSchema(pool) {
  // The baseline normally comes from db/init.sql, which only runs inside the
  // Postgres container. Recreate just the table the migrations build on - as init.sql
  // has it, with `is_published`: migration 008 derives `status` from it and 009 drops it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id               VARCHAR(100)  PRIMARY KEY,
      title            VARCHAR(255)  NOT NULL,
      description      TEXT          NOT NULL DEFAULT '',
      full_description TEXT          NOT NULL DEFAULT '',
      category         VARCHAR(50)   NOT NULL,
      category_label   VARCHAR(100)  NOT NULL,
      image_url        TEXT          NOT NULL DEFAULT '',
      scenario_url     TEXT          NOT NULL DEFAULT '',
      version          VARCHAR(20)   DEFAULT '1.0.0',
      author           VARCHAR(255),
      upload_date      TIMESTAMPTZ   DEFAULT NOW(),
      is_published     BOOLEAN       DEFAULT true,
      created_at       TIMESTAMPTZ   DEFAULT NOW(),
      updated_at       TIMESTAMPTZ   DEFAULT NOW()
    )
  `);

  await runMigrations(pool);
}

async function truncateAll(pool) {
  await pool.query('TRUNCATE scenarios, scenario_versions, scenario_sessions, categories, publish_keys, audit_events RESTART IDENTITY CASCADE');
}

/**
 * Seeds a fixed catalog: 3 published across 2 categories, 2 unpublished.
 *
 * `created_at` is set explicitly and distinctly so ordering assertions are
 * deterministic; two rows share a timestamp on purpose, which is what the
 * `id` tiebreaker in the catalog query exists for.
 */
async function seedScenarios(pool) {
  // Same shape migration 006 seeds: label order x 10, prototype icons.
  await pool.query(`
    INSERT INTO categories (slug, label, icon, sort_order) VALUES
      ('astronomy', 'Астрономія', 'planet',    10),
      ('biology',   'Біологія',   'dna',       20),
      ('physics',   'Фізика',     'lightning', 30)
  `);

  await pool.query(`
    INSERT INTO scenarios
      (id, title, description, category, category_label, scenario_url, status, created_at)
    VALUES
      ('solar-system', 'Сонячна Система', 'Модель планетарної системи',
       'astronomy', 'Астрономія', '/scenarios/aaa.zip', 'published',  '2026-01-05T00:00:00Z'),
      ('cell-biology', 'Будова клітини', 'Органели та мембрана',
       'biology', 'Біологія', '/scenarios/bbb.zip', 'published',  '2026-01-04T00:00:00Z'),
      ('tie-a', 'Однакова мітка А', 'tie',
       'biology', 'Біологія', '/scenarios/ccc.zip', 'published',  '2026-01-03T00:00:00Z'),
      ('tie-b', 'Однакова мітка Б', 'tie',
       'biology', 'Біологія', '', 'published',  '2026-01-03T00:00:00Z'),
      ('hidden-one', 'Прихований', 'not published',
       'physics', 'Фізика', '/scenarios/ddd.zip', 'draft', '2026-01-02T00:00:00Z'),
      ('drive-legacy', 'Legacy Drive', 'external',
       'physics', 'Фізика',
       'https://drive.google.com/file/d/FAKEID/view?usp=sharing', 'draft', '2026-01-01T00:00:00Z')
  `);
}

/**
 * Gives scenario `id` a `current` archive version straight in SQL (and points its row at it),
 * so a test of something else need not upload a ZIP to make the row approvable.
 * `sha` is any 64 hex characters; the object itself is not stored.
 */
async function addCurrentVersion(pool, id, sha = 'a'.repeat(64)) {
  await pool.query(`
    INSERT INTO scenario_versions (scenario_id, sha256, bytes, state) VALUES ($1, $2, 1000, 'current')`, [id, sha]);
  await pool.query(`
    UPDATE scenarios SET archive_sha256 = $2, archive_bytes = 1000, scenario_url = $3 WHERE id = $1`,
  [id, sha, `/scenarios/${sha}.zip`]);
}

/** Puts a row at `status` directly (no transition rules, no audit): fixtures only. */
const setStatus = (pool, id, status) => pool.query('UPDATE scenarios SET status = $2 WHERE id = $1', [id, status]);

const PUBLISHED_COUNT = 4;

module.exports = {
  isAvailable, prepareSchema, truncateAll, seedScenarios, addCurrentVersion, setStatus, PUBLISHED_COUNT,
};
