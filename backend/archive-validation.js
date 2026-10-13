// backend/archive-validation.js
//
// Validates a scenario archive before it is allowed into the store.
//
// The engine (`Application.loadScenarioFromBuffer`) receives only the ZIP
// bytes — it never sees the catalog row — so nothing at runtime checks that an
// archive is what the catalog claims. Rejecting a broken archive here is far
// cheaper than a student hitting an opaque engine error.
//
// What the student player can read (manifest and scene/prefab format versions)
// is stated once, in `player-formats.js`; this file only applies it.

const StreamZip = require('node-stream-zip');

const { isSceneFile, sceneFileProblem, manifestVersionProblem } = require('./player-formats');

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
 * Reads and checks `manifest.json` inside `filePath`, and every scene or prefab
 * file beside it.
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
    const entryMap = await zip.entries();
    const entries = Object.keys(entryMap);

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

    const versionProblem = manifestVersionProblem(manifest.manifestVersion);
    if (versionProblem) throw new ArchiveInvalid(versionProblem);

    // entryPoint is relative to scripts/ (see IScenarioManifest.entryPoint).
    const entryPath = SCRIPTS_DIR + String(manifest.entryPoint).replace(/^\/+/, '');
    if (!entries.includes(entryPath)) {
      throw new ArchiveInvalid(`Точка входу "${entryPath}" відсутня в архіві`);
    }

    // The deployed player checks no scene format version, so a newer scene would
    // load hollow rather than fail. Read one at a time, so peak memory is the
    // largest file, not their sum; like manifest.json, no file has a size limit
    // of its own beyond the upload's.
    for (const entry of Object.values(entryMap)) {
      if (entry.isDirectory || !isSceneFile(entry.name)) continue;

      let data;
      try {
        data = await zip.entryData(entry.name);
      } catch {
        throw new ArchiveInvalid(`Файл "${entry.name}" не читається з архіву (пошкоджений або стиснений непідтримуваним методом)`);
      }
      const problem = sceneFileProblem(entry.name, data);
      if (problem) throw new ArchiveInvalid(problem);
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
