// backend/archive-validation.js
//
// Validates a scenario archive before it is allowed into the store.
//
// The engine (`Application.loadScenarioFromBuffer`) receives only the ZIP
// bytes — it never sees the catalog row — so nothing at runtime checks that an
// archive is what the catalog claims. Rejecting a broken archive here is far
// cheaper than a student hitting an opaque engine error.

const StreamZip = require('node-stream-zip');

const MANIFEST_NAME = 'manifest.json';
const SCRIPTS_DIR = 'scripts/';

/** Fields the engine's `IScenarioManifest` requires. */
const REQUIRED_FIELDS = ['manifestVersion', 'id', 'name', 'version', 'entryPoint'];

class ArchiveInvalid extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * Reads and checks `manifest.json` inside `filePath`.
 *
 * Returns `{ manifest, entries, warnings }`. Throws `ArchiveInvalid` (status 400)
 * with a specific message when the archive cannot be a scenario.
 *
 * @param {string} filePath  archive on disk
 * @param {string} catalogId id of the catalog row it is being attached to
 */
async function validateScenarioArchive(filePath, catalogId) {
  let zip;

  try {
    zip = new StreamZip.async({ file: filePath });
    await zip.entriesCount;
  } catch {
    throw new ArchiveInvalid('Файл не читається як ZIP-архів');
  }

  try {
    const entries = Object.keys(await zip.entries());

    if (!entries.includes(MANIFEST_NAME)) {
      throw new ArchiveInvalid(`В архіві немає ${MANIFEST_NAME} у корені`);
    }

    let manifest;
    try {
      manifest = JSON.parse(await zip.entryData(MANIFEST_NAME));
    } catch {
      throw new ArchiveInvalid(`${MANIFEST_NAME} не є валідним JSON`);
    }

    const missing = REQUIRED_FIELDS.filter(field => !manifest[field]);
    if (missing.length > 0) {
      throw new ArchiveInvalid(`У ${MANIFEST_NAME} відсутні поля: ${missing.join(', ')}`);
    }

    // entryPoint is relative to scripts/ (see IScenarioManifest.entryPoint).
    const entryPath = SCRIPTS_DIR + String(manifest.entryPoint).replace(/^\/+/, '');
    if (!entries.includes(entryPath)) {
      throw new ArchiveInvalid(`Точка входу "${entryPath}" відсутня в архіві`);
    }

    const warnings = [];

    // Deliberately a warning, not a rejection: real archives use reverse-domain
    // manifest ids (`template.benchscene1.primitives`) while the catalog uses
    // slugs, and the engine never compares the two. Recording the drift is
    // useful; refusing the upload would reject every existing scenario.
    if (catalogId && manifest.id !== catalogId) {
      warnings.push(
        `id у маніфесті ("${manifest.id}") відрізняється від id у каталозі ("${catalogId}")`
      );
    }

    return { manifest, entries, warnings };
  } finally {
    await zip.close().catch(() => {});
  }
}

module.exports = { validateScenarioArchive, ArchiveInvalid, MANIFEST_NAME };
