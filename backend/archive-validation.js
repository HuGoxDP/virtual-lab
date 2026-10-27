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

const fsp = require('node:fs/promises');

const StreamZip = require('node-stream-zip');

const { MAX_ENTRY_BYTES, MAX_ARCHIVE_ENTRIES } = require('./config');

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

const EOCD_SIGNATURE = 0x06054b50;
/** The end-of-central-directory record is 22 bytes plus a comment of at most 65535. */
const EOCD_SEARCH_BYTES = 22 + 0xffff;
/**
 * The entry count a ZIP declares, read from its end-of-central-directory record
 * without parsing the directory — so a hostile count is refused before the
 * parser allocates a record per entry. 0xFFFF means "zip64, at least this many", which
 * still exceeds any sane cap; the real parser re-checks the exact count. Null when
 * no record is found (the real parser will then say so).
 */
async function declaredEntryCount(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, EOCD_SEARCH_BYTES);
    const tail = Buffer.alloc(length);
    await handle.read(tail, 0, length, size - length);

    for (let at = length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
      return tail.readUInt16LE(at + 10);
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Reads one entry, never holding more than `maxBytes` of it. The declared size
 * is checked first, but it comes from the archive and can lie, so the stream is
 * also counted and cut off the moment it passes the cap — a zip bomb ends here.
 */
async function readEntryCapped(zip, entry, maxBytes) {
  const tooLarge = () => new ArchiveInvalid(
    `Файл "${entry.name}" завеликий: максимум ${maxBytes} байт після розпакування`
  );
  if (entry.size > maxBytes) throw tooLarge();

  const stream = await zip.stream(entry.name);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
 * @param {{maxEntryBytes?: number, maxEntries?: number}} [limits]  override the env caps (tests)
 */
async function validateScenarioArchive(filePath, catalogId, limits = {}) {
  const { maxEntryBytes = MAX_ENTRY_BYTES, maxEntries = MAX_ARCHIVE_ENTRIES } = limits;
  const tooManyEntries = () => new ArchiveInvalid(`В архіві забагато файлів: максимум ${maxEntries}`);

  // Refuse a hostile entry count before the parser builds a record for each one.
  if (await declaredEntryCount(filePath).catch(() => null) > maxEntries) throw tooManyEntries();

  let zip;

  try {
    zip = new StreamZip.async({ file: filePath });
    await zip.entriesCount;
  } catch {
    throw new ArchiveInvalid('Файл не читається як ZIP-архів');
  }

  try {
    if (await zip.entriesCount > maxEntries) throw tooManyEntries();
    const entryMap = await zip.entries();
    const entries = Object.keys(entryMap);

    if (!entries.includes(MANIFEST_NAME)) {
      throw new ArchiveInvalid(`В архіві немає ${MANIFEST_NAME} у корені`);
    }

    let manifest;
    try {
      manifest = JSON.parse(await readEntryCapped(zip, entryMap[MANIFEST_NAME], maxEntryBytes));
    } catch (err) {
      if (err instanceof ArchiveInvalid) throw err;
      throw new ArchiveInvalid(`${MANIFEST_NAME} не є валідним JSON`);
    }
    console.log(`[VALIDATE] ${MANIFEST_NAME} розібрано: id="${manifest.id}", entryPoint="${manifest.entryPoint}"`);

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
    // largest file, not their sum, and each is capped at `maxEntryBytes`.
    for (const entry of Object.values(entryMap)) {
      if (entry.isDirectory || !isSceneFile(entry.name)) continue;

      let data;
      try {
        data = await readEntryCapped(zip, entry, maxEntryBytes);
      } catch (err) {
        if (err instanceof ArchiveInvalid) throw err;
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
      console.log(`[VALIDATE] id не збігається: маніфест="${manifest.id}", каталог="${catalogId}" — публікацію це не блокує`);
    } else if (catalogId) {
      console.log(`[VALIDATE] id збігається: "${catalogId}"`);
    }

    return { manifest, entries, warnings };
  } finally {
    await zip.close().catch(() => {});
  }
}

module.exports = { validateScenarioArchive, ArchiveInvalid, MANIFEST_NAME, declaredEntryCount };
