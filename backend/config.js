// backend/config.js
//
// Limits read once at load and shared by more than one route module.

/**
 * Largest archive accepted on upload.
 *
 * Everything else that used to live beside it — Google Drive URL rewriting,
 * confirmation-page scraping, a host allowlist and a redirect-following
 * fetcher — is gone: every catalog row is served from local storage now, so
 * none of it had a caller.
 */
const DEFAULT_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/** Read once at load; a junk value falls back to the default rather than disabling the cap. */
function parseMaxArchiveBytes(raw) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_ARCHIVE_BYTES;
}

const MAX_ARCHIVE_BYTES = parseMaxArchiveBytes(process.env.MAX_ARCHIVE_BYTES);

module.exports = { MAX_ARCHIVE_BYTES, parseMaxArchiveBytes };
