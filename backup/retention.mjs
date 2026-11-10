// backup/retention.mjs
//
// Which backup directories survive. Pure: names and a clock in, a list of names
// out — no filesystem access, so the pruning rules are unit-testable without a
// Docker stack (see test/unit/retention.test.js).

/** A backup directory name: the UTC instant it was taken, `:` and `.` flattened. */
export const BACKUP_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/;

/**
 * Parses a backup directory name.
 *
 * @returns {Date|null} the instant, or `null` when the name is not one of ours.
 * A directory this module did not name is never a directory it may delete.
 */
export function parseBackupName(name) {
    const m = BACKUP_NAME_RE.exec(String(name ?? ""));
    if (!m) return null;
    const [_, y, mo, d, h, mi, s] = m;
    const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    if (Number.isNaN(date.getTime())) return null;
    // `Date.UTC` rolls overflow over (month 13 becomes January, the 99th of a
    // month becomes a day in the next), so a pattern match alone would hand a
    // garbage name a confident instant. The rebuild is the range check.
    return formatBackupName(date) === String(name) ? date : null;
}

/** The name a backup taken at `when` gets. */
export function formatBackupName(when) {
    const p = (n, w = 2) => String(n).padStart(w, "0");
    const d = when instanceof Date ? when : new Date(when);
    return [
        d.getUTCFullYear(), p(d.getUTCMonth() + 1), p(d.getUTCDate()),
    ].join("-") + "T" + [p(d.getUTCHours()), p(d.getUTCMinutes()), p(d.getUTCSeconds())].join("-") + "Z";
}

/**
 * The backup directories to delete so that `keepDays` days of history remain.
 *
 * Rules, in order:
 * - a name this module did not produce is never a candidate (someone else's
 *   data stays where it is);
 * - a backup strictly older than `keepDays` days is deleted;
 * - the newest backup is always kept, even past the retention window — a
 *   schedule that never ran again must not leave an empty backup directory;
 * - the result is sorted oldest first, so a caller that fails halfway has
 *   deleted the least valuable backups first.
 *
 * @param {string[]} names directory names (not paths) under the backup root
 * @param {{keepDays?: number, now?: Date|number}} options
 * @returns {string[]} the names to delete
 */
export function selectForDeletion(names, { keepDays = 14, now = new Date() } = {}) {
    if (!Number.isFinite(keepDays) || keepDays < 0) {
        throw new Error(`keepDays must be a non-negative number, got ${keepDays}`);
    }
    const timestamped = [];
    for (const name of names ?? []) {
        const at = parseBackupName(name);
        if (at) timestamped.push({ name, at });
    }
    if (timestamped.length === 0) return [];
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const cutoff = nowMs - keepDays * 86400000;
    const newest = timestamped.reduce((a, b) => (b.at > a.at ? b : a));
    return timestamped
        .filter((b) => b.at.getTime() < cutoff && b !== newest)
        .sort((a, b) => a.at - b.at)
        .map((b) => b.name);
}
