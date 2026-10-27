// backend/scenario-rows.js
//
// The admin projection of a scenario row, shared by the admin listing and by the routes
// that answer with the row they just created.

/**
 * Every column the admin sees, aliased to camelCase. `isPublished` is the compatibility
 * field (`status = 'published'`) for readers that predate the workflow statuses.
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
  updated_at         AS "updatedAt",
  CASE WHEN jsonb_typeof(features) = 'array' THEN features ELSE '[]'::jsonb END AS features
`;

/** One admin row by id, or undefined. */
async function fetchAdminRow(db, id) {
  const { rows } = await db.query(`SELECT ${ADMIN_COLUMNS} FROM scenarios WHERE id = $1`, [id]);
  return rows[0];
}

module.exports = { ADMIN_COLUMNS, fetchAdminRow };
