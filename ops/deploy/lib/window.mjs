// ops/deploy/lib/window.mjs
//
// When a deploy may start (decision D-6): Mon–Fri between 21:00 and 06:00
// Europe/Kyiv, any time at weekends. DST is `Intl`'s job, not ours — a table of
// Ukrainian DST dates would be wrong on the first rule change and would be
// wrong about 2026 twice already.
//
// A pure function of an instant, so a table test can name every boundary:
// Friday 20:59 vs 21:00, Monday 05:59 vs 06:00, and both DST change days.

const KYIV = 'Europe/Kyiv';

/** A formatter that answers "what is the wall clock in Kyiv?" for an instant. */
const partsOf = instant => {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: KYIV,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out = {};
  for (const piece of fmt.formatToParts(instant)) {
    if (piece.type !== 'literal') out[piece.type] = piece.value;
  }
  return out;
};

const WEEKEND = new Set(['Sat', 'Sun']);

/**
 * Whether a deploy may start at `instant`.
 *
 * @param {Date|number|string} instant
 * @returns {{allowed: boolean, kyivLocal: string, reason: string}}
 *   `reason` is empty when allowed, and otherwise says the window and the local
 *   time — so a caller (or a human) can see *why*, not just "no".
 */
export function deployWindow(instant) {
  const at = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(at.getTime())) {
    throw new RangeError(`deployWindow: not an instant: ${String(instant)}`);
  }
  const p = partsOf(at);
  const kyivLocal = `${p.weekday} ${p.hour}:${p.minute} Europe/Kyiv`;
  const weekend = WEEKEND.has(p.weekday);
  const hour = Number(p.hour);
  // 21:00..05:59 is the weekday window; the hours 06:00..20:59 are not, and
  // Friday 21:00 rolls into Saturday's "any time" without a gap.
  const night = hour >= 21 || hour < 6;
  if (weekend) return { allowed: true, kyivLocal, reason: '' };
  if (night) return { allowed: true, kyivLocal, reason: '' };
  return {
    allowed: false,
    kyivLocal,
    reason: `a deploy may only start 21:00–06:00 Europe/Kyiv on weekdays; it is ${kyivLocal}`,
  };
}
