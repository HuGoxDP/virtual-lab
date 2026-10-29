// backend/config.js
//
// Limits read once at load and shared by more than one module.

/** A junk, zero or negative value falls back to the default rather than disabling a cap. */
function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Largest archive accepted on upload.
 *
 * Everything else that used to live beside it — Google Drive URL rewriting,
 * confirmation-page scraping, a host allowlist and a redirect-following
 * fetcher — is gone: every catalog row is served from local storage now, so
 * none of it had a caller.
 */
const DEFAULT_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

function parseMaxArchiveBytes(raw) {
  return parsePositiveInt(raw, DEFAULT_MAX_ARCHIVE_BYTES);
}

const MAX_ARCHIVE_BYTES = parseMaxArchiveBytes(process.env.MAX_ARCHIVE_BYTES);

/**
 * Archive-validation caps. The largest real manifest or scene entry measured
 * 3 KB and the largest real archive 31 entries (ScenarioCreator release plus
 * the dev stack's store, 2026-10-27), so these leave three orders of magnitude.
 */
const MAX_ENTRY_BYTES = parsePositiveInt(process.env.MAX_ENTRY_BYTES, 10 * 1024 * 1024);
const MAX_ARCHIVE_ENTRIES = parsePositiveInt(process.env.MAX_ARCHIVE_ENTRIES, 20_000);

/** Uploads one author key may start per hour (moderators and the bootstrap token are exempt). */
const AUTHOR_UPLOADS_PER_HOUR = parsePositiveInt(process.env.AUTHOR_UPLOADS_PER_HOUR, 20);

/** Failed credential checks one address may make per 15 minutes before it is answered 429. */
const AUTH_FAILURES_PER_WINDOW = parsePositiveInt(process.env.AUTH_FAILURES_PER_WINDOW, 30);

/**
 * Cover-image limits, shown to the author by `/api/config` and enforced on upload
 * (`preview-image.js`). A 16:10 image at 800 px is 500 px tall; `PREVIEW_MAX_DIMENSION`
 * only guards against a small file that decodes to a gigapixel bitmap in a student's browser.
 */
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_MIN_WIDTH = 800;
const PREVIEW_ASPECT = 16 / 10;
const PREVIEW_ASPECT_TOLERANCE = 0.05;
const PREVIEW_MAX_DIMENSION = 8192;

/** Most scenarios one bulk request may name. */
const MAX_BULK_IDS = 100;

module.exports = {
  PREVIEW_MAX_BYTES,
  PREVIEW_MIN_WIDTH,
  PREVIEW_ASPECT,
  PREVIEW_ASPECT_TOLERANCE,
  PREVIEW_MAX_DIMENSION,
  MAX_BULK_IDS,
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_BYTES,
  MAX_ARCHIVE_ENTRIES,
  AUTHOR_UPLOADS_PER_HOUR,
  AUTH_FAILURES_PER_WINDOW,
  parseMaxArchiveBytes,
  parsePositiveInt,
};
