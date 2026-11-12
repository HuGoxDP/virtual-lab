// ops/deploy/lib/rollback.mjs
//
// Whether a rollback has to bring the database back too (decision D-10).
//
// Migrations only run forward (fact F-6: `backend/migrations.js` applies every
// file not yet in `schema_migrations`, and there is no down-migration). So an
// old image on a database a newer image migrated may fail — and starting on a
// migrated database is how a rollback turns into an outage. The pipeline
// therefore asks this function after a deploy, not before.

/**
 * Does `after`'s migration set add entries that were not in `before`?
 *
 * @param {string[]} before — the migration names the backup was taken with.
 * @param {string[]} after — the names now applied.
 * @returns {boolean} true when the deploy migrated, so a rollback restores the
 *   backup as well as the previous image.
 * @throws {Error} when `after` is missing an entry of `before`: the set shrank,
 *   which cannot happen with forward-only migrations and means the two sides
 *   read different databases (or one of them read nothing). Rollback + restore
 *   + exit 11 is the caller's answer, and it must not be guessed at here.
 */
export function needsDbRestore(before, after) {
  const was = new Set(before ?? []);
  const now = new Set(after ?? []);
  for (const name of was) {
    if (!now.has(name)) {
      throw new Error(
        `migration set shrank: "${name}" was applied and is not any more — `
        + 'the deploy read a different database than the backup did'
      );
    }
  }
  for (const name of now) {
    if (!was.has(name)) return true;
  }
  return false;
}
