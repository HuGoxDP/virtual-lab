// backend/player-formats.js
//
// What the deployed student player can read — the one place that says so.
//
// The player is the engine build the frontend ships (`frontend/WebEngineTS-0.1.0.tgz`,
// checked against 0.1.0-local.1789023160893). The platform refuses at upload (and so
// in `publish:release`) and at `import:assets` anything that build would misread,
// because the player itself does not always refuse: that build checks no scene or
// prefab format version at all, so a version-2 ("link mode") scene would load hollow
// and silently, in front of a student. Refusing to store what a deployed reader cannot
// read is the same rule Kubernetes applies to API versions and glTF to
// `extensionsRequired`.
//
// **When to raise these, and why not sooner.**
//
//   SCENE_FORMAT_VERSIONS — add 2 only when BOTH hold:
//     1. the engine in the frontend tarball reads the version (it has
//        `SceneSerializer._refuseUnknownVersion` and accepts 2), and
//     2. what reaches the player is complete with it. A link-mode scene names
//        prefabs that must be loaded before it is deserialized; the editor's
//        exported-scenario template (`SCENARIO_TEMPLATE` in WebEngineTSEditor)
//        calls `SceneSerializer.deserializeScene` without preloading any, so
//        even a v2-capable engine would build placeholders there.
//     Until then the editor's Build/Publish is to expand links, so archives carry
//     version 1. Raising early lets a hollow scene through to students; raising
//     late only refuses an upload, which is the cheap failure.
//
//   MANIFEST_MAJOR_VERSIONS — `manifest.json`'s `manifestVersion` is a string
//     like "1.0". Every producer writes "1.0": ScenarioCreator's build-package.mjs
//     (every archive in the catalog came from it), and the engine's
//     StreamingManifest.ts (`SCENARIO_MANIFEST_VERSION`) when it converts a
//     streaming manifest. The editor has no packager of its own; its projects are
//     built by ScenarioCreator. The engine itself only checks the field is present,
//     so a minor bump is additive and passes; add a major only once the frontend's
//     engine reads it.
//
//   STREAMING_SCHEMA_VERSIONS — a streaming manifest's `schema`. The engine
//     refuses any other value itself; checking at import keeps it out of the store.
//
// test/unit/player-formats.test.js pins all three, so raising one is a decision
// that edits that test too, never a drive-by.

/** Scene (`*.scene.json`) and prefab (`*.prefab.json`) format versions. Absent means 1. */
const SCENE_FORMAT_VERSIONS = Object.freeze([1]);

/** Major versions of `manifestVersion` in an archive's `manifest.json`. */
const MANIFEST_MAJOR_VERSIONS = Object.freeze([1]);

/** `schema` values of a streaming manifest (`<id>.scenario.json`). */
const STREAMING_SCHEMA_VERSIONS = Object.freeze([1]);

const SCENE_FILE = /\.(scene|prefab)\.json$/i;

/** macOS Archive Utility's resource-fork copies: `__MACOSX/…` and `._<name>`. Binary, never read. */
const APPLE_DOUBLE = /(^|\/)(__MACOSX\/|\._[^/]*$)/;

/**
 * Whether an archive entry or asset path is a scene or prefab file. The anchored
 * extension already excludes a directory entry (it ends in "/"), and AppleDouble
 * copies are skipped: the engine never reads them, and refusing a valid archive
 * zipped on a Mac over one would name a file its author never made.
 */
function isSceneFile(name) {
  return typeof name === 'string' && SCENE_FILE.test(name) && !APPLE_DOUBLE.test(name);
}

/** A value as a message shows it: strings quoted, so "2" and 2 read differently. */
function shown(value) {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/** "лише версію 1" / "лише версії 1, 2". */
function readsOnly(versions, suffix = '') {
  const list = versions.map(v => `${v}${suffix}`);
  return list.length === 1 ? `лише версію ${list[0]}` : `лише версії ${list.join(', ')}`;
}

/**
 * Checks one scene or prefab file. Returns why the player cannot read it, or null.
 *
 * Decoded the way the player decodes it (`Blob.text()`: UTF-8, BOM dropped), so a
 * file the player reads is never refused here for its encoding.
 *
 * @param {string} name  path inside the archive, named in the message
 * @param {Buffer|Uint8Array|string} data
 */
function sceneFileProblem(name, data) {
  const kind = /\.prefab\.json$/i.test(name) ? 'префаба' : 'сцени';

  let json;
  try {
    const text = typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data);
    json = JSON.parse(text);
  } catch {
    return `Файл ${kind} "${name}" не є валідним JSON`;
  }

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return `Файл ${kind} "${name}" має містити JSON-об'єкт`;
  }

  const version = json.version === undefined ? 1 : json.version;

  if (!Number.isInteger(version)) {
    return `У файлі ${kind} "${name}" поле version має бути цілим числом, а не ${shown(version)}; ` +
      `вʼюер платформи читає ${readsOnly(SCENE_FORMAT_VERSIONS)}`;
  }

  if (!SCENE_FORMAT_VERSIONS.includes(version)) {
    return `Файл ${kind} "${name}" має формат версії ${version}, ` +
      `а вʼюер платформи читає ${readsOnly(SCENE_FORMAT_VERSIONS)}`;
  }

  return null;
}

/**
 * Checks `manifest.json`'s `manifestVersion`. Returns why the player cannot read it, or null.
 *
 * A number is taken as its decimal form (1 → "1"), since the engine never parses
 * the field and an archive that wrote one has always loaded.
 */
function manifestVersionProblem(value) {
  const match = (typeof value === 'string' || typeof value === 'number')
    ? /^(\d+)(?:\.\d+)*$/.exec(String(value))
    : null;

  if (!match) {
    return `У manifest.json manifestVersion має бути номером версії на зразок "1.0", а не ${shown(value)}`;
  }

  const major = Number(match[1]);
  if (!MANIFEST_MAJOR_VERSIONS.includes(major)) {
    return `manifest.json має manifestVersion ${shown(value)}, ` +
      `а вʼюер платформи читає ${readsOnly(MANIFEST_MAJOR_VERSIONS, '.x')}`;
  }

  return null;
}

/**
 * Checks a parsed streaming manifest and every scene or prefab file it lists.
 * Returns the first reason the player cannot read it, or null.
 *
 * @param {object} manifest  parsed `<id>.scenario.json`
 * @param {(url: string) => Promise<Buffer|null>} readObject
 *        the bytes behind one LOD url, or null when the object is missing —
 *        a missing object is the caller's to report, not a format problem
 */
async function streamingManifestProblem(manifest, readObject) {
  const where = `маніфесті "${manifest.id}"`;
  const schema = manifest.schema;

  if (schema === undefined) {
    return `У ${where} поле schema відсутнє; вʼюер платформи читає ${readsOnly(STREAMING_SCHEMA_VERSIONS)}`;
  }
  if (!Number.isInteger(schema)) {
    return `У ${where} поле schema має бути цілим числом, а не ${shown(schema)}; ` +
      `вʼюер платформи читає ${readsOnly(STREAMING_SCHEMA_VERSIONS)}`;
  }
  if (!STREAMING_SCHEMA_VERSIONS.includes(schema)) {
    return `У ${where} поле schema має значення ${schema}, ` +
      `а вʼюер платформи читає ${readsOnly(STREAMING_SCHEMA_VERSIONS)}`;
  }

  for (const asset of Array.isArray(manifest.assets) ? manifest.assets : []) {
    if (!isSceneFile(asset?.path)) continue;

    for (const lod of Array.isArray(asset.lods) ? asset.lods : []) {
      if (typeof lod?.url !== 'string') continue;
      const data = await readObject(lod.url);
      if (data === null) continue;

      const problem = sceneFileProblem(asset.path, data);
      if (problem) return problem;
    }
  }

  return null;
}

module.exports = {
  SCENE_FORMAT_VERSIONS,
  MANIFEST_MAJOR_VERSIONS,
  STREAMING_SCHEMA_VERSIONS,
  isSceneFile,
  sceneFileProblem,
  manifestVersionProblem,
  streamingManifestProblem,
};
