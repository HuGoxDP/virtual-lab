// ops/deploy/lib/shq.mjs
//
// POSIX single-quote quoting. Every value that travels to a remote script goes
// through here, and nothing is ever interpolated into a script body: the value
// is one argument, quoted so that the shell on the other side cannot read
// anything into it but itself. A command substitution inside a quoted word is
// data, and that is the whole point.

/**
 * Quotes `value` for a POSIX shell (`bash -s` on the remote side).
 *
 * @param {string|number} value — anything that has to become one argv entry.
 * @returns {string} the quoted word: `'...'`, with an embedded `'` as `'\''`.
 */
export function shq(value) {
  const text = value === null || value === undefined ? '' : String(value);
  // Empty is not omitted: an argument must exist even when it is empty, or the
  // positional list shifts and the remote script reads the wrong parameter.
  if (text === '') return "''";
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Quotes every entry, in order — what a remote script's `$1…$n` receive.
 * @param {Array<string|number>} values
 * @returns {string[]} one quoted word per value.
 */
export function shqArgs(values) {
  return Array.from(values ?? [], shq);
}
