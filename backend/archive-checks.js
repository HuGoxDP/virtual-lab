// backend/archive-checks.js
//
// The static checks a moderator reads on the "Перевірка" tab: what the validator found in an
// archive, as `{ ok, items: [{ level, label, note }] }`. Stored in `scenario_versions.checks`
// when a version is created and refreshed by the re-run route.
//
// There is one rule set: `checksFromValidation` turns what `validateScenarioArchive` returned
// into items (used at upload, which already holds that result), and `runArchiveChecks` runs the
// validator over a stored object first (the re-run). An archive the validator refuses is not an
// exception here but an `error` item - the point of the tab is to show it.

const { validateScenarioArchive, ArchiveInvalid } = require('./archive-validation');

const item = (level, label, note) => ({ level, label, note });

/**
 * @param {{manifest: object, entries: string[], warnings: string[]}} validated  `validateScenarioArchive`'s result
 * @param {number} bytes  archive size on disk
 */
function checksFromValidation({ manifest, entries, warnings }, bytes) {
  const files = entries.filter(name => !name.endsWith('/')).length;
  const items = [
    item('ok', 'Маніфест', `id "${manifest.id}", версія ${manifest.version}, точка входу ${manifest.entryPoint}`),
    item('ok', 'Файли', `${files} файл(ів), ${bytes} байт`),
  ];

  for (const warning of warnings) items.push(item('warning', 'Ідентифікатор', warning));
  items.push(manifest.engineVersion
    ? item('ok', 'Версія рушія', manifest.engineVersion)
    : item('warning', 'Версія рушія', 'Маніфест не вказує engineVersion: невідомо, під який рушій зібрано сценарій'));

  return { ok: true, items };
}

/** The error-only result for an archive the validator refused. */
const failedChecks = message => ({ ok: false, items: [item('error', 'Перевірка архіву', message)] });

/**
 * Validates the archive at `filePath` and returns its checks. Never throws for an invalid
 * archive; anything that is not a validation refusal (an I/O fault) propagates.
 *
 * @param {number} bytes  archive size, for the files line
 */
async function runArchiveChecks(filePath, catalogId, bytes) {
  try {
    return checksFromValidation(await validateScenarioArchive(filePath, catalogId), bytes);
  } catch (err) {
    if (err instanceof ArchiveInvalid) return failedChecks(err.message);
    throw err;
  }
}

module.exports = { checksFromValidation, failedChecks, runArchiveChecks };
