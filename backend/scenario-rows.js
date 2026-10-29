// backend/scenario-rows.js
//
// The admin projection of a scenario row, shared by the admin listing and by the routes
// that answer with the row they just created.

/**
 * Every column the admin sees, aliased to camelCase. `isPublished` is the compatibility
 * field (`status = 'published'`) for readers that predate the workflow statuses. The three
 * correlated subqueries feed the moderation queue: who owns the row (`ownerLabel`, null for the
 * bootstrap), the author's waiting archive (`pendingVersionId`), and the version students get with
 * its check counts (`currentVersion`, null before the first archive; `checked` is false for a
 * version that predates stored checks, so its zero counts are not read as "clean").
 * Callers select `FROM scenarios` unaliased, which the subqueries rely on.
 */
const ADMIN_COLUMNS = `
  id, title, description,
  full_description   AS "fullDescription",
  category,
  category_label     AS "categoryLabel",
  image_url          AS "imageUrl",
  scenario_url       AS "scenarioUrl",
  manifest_url       AS "manifestUrl",
  version, author,
  upload_date        AS "uploadDate",
  status,
  (status = 'published') AS "isPublished",
  moderator_note     AS "moderatorNote",
  submitted_at       AS "submittedAt",
  storage_kind       AS "storageKind",
  archive_sha256     AS "archiveSha256",
  archive_bytes      AS "archiveBytes",
  manifest_id        AS "manifestId",
  manifest_version   AS "manifestVersion",
  manifest_engine_version AS "manifestEngineVersion",
  owner_key_id       AS "ownerKeyId",
  (SELECT k.label FROM publish_keys k WHERE k.id = scenarios.owner_key_id) AS "ownerLabel",
  (SELECT v.id FROM scenario_versions v
    WHERE v.scenario_id = scenarios.id AND v.state = 'pending')            AS "pendingVersionId",
  (SELECT jsonb_build_object(
            'id', v.id, 'sha256', v.sha256, 'bytes', v.bytes::float8,
            'checked', v.checks IS NOT NULL,
            'checks', jsonb_build_object(
              'errors',   (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(v.checks->'items', '[]'::jsonb)) i
                            WHERE i->>'level' = 'error'),
              'warnings', (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(v.checks->'items', '[]'::jsonb)) i
                            WHERE i->>'level' = 'warning')))
     FROM scenario_versions v
    WHERE v.scenario_id = scenarios.id AND v.state = 'current')            AS "currentVersion",
  updated_at         AS "updatedAt",
  CASE WHEN jsonb_typeof(features) = 'array' THEN features ELSE '[]'::jsonb END AS features
`;

/** One admin row by id, or undefined. */
async function fetchAdminRow(db, id) {
  const { rows } = await db.query(`SELECT ${ADMIN_COLUMNS} FROM scenarios WHERE id = $1`, [id]);
  return rows[0];
}

/** A scenario joined to its category, as `s` and `c`: the aliases `PUBLIC_ROW` is written against. */
const ITEM_FROM = 'FROM scenarios s LEFT JOIN categories c ON c.slug = s.category';

/**
 * What every public reader may show: published, and not in a hidden category. A slug with no
 * category row (the table has no foreign key on purpose) stays visible. One fragment, so the
 * catalog list, summary, related, by-id, version-preview and LTI launch/grade routes cannot disagree
 * about "unpublished". Use it with `ITEM_FROM`; add every new public read to it.
 */
const PUBLIC_ROW = "s.status = 'published' AND COALESCE(c.is_visible, true)";

module.exports = { ADMIN_COLUMNS, ITEM_FROM, PUBLIC_ROW, fetchAdminRow };
