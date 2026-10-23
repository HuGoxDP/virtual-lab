// path: src/app/ui/format.ts

// ==================== BYTES ====================

/** Ukrainian unit labels, smallest first; 1024 steps. */
const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ'] as const;

/**
 * `48,2 МБ`: one decimal with a comma, a whole value drops it (`200 МБ`), and `''` for a missing
 * or nonsensical size so a card or table can render nothing instead of "NaN".
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';

  let unit = 0;
  let value = bytes;
  while (unit < BYTE_UNITS.length - 1 && value >= 1024) {
    value /= 1024;
    unit++;
  }

  // 1 048 575 B is 1023,999 КБ: it rounds to 1024 КБ, which reads better as 1 МБ.
  let rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  if (rounded >= 1024 && unit < BYTE_UNITS.length - 1) {
    rounded = Math.round((rounded / 1024) * 10) / 10;
    unit++;
  }
  return `${String(rounded).replace('.', ',')} ${BYTE_UNITS[unit]}`;
}

// ==================== DATES ====================

/** Short month names as the prototype writes them (`бер`, not Intl's `бер.`). */
const MONTHS_UK = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'] as const;

/** Calendar parts in Kyiv; Intl supplies only the time-zone arithmetic, never the words. */
const KYIV_PARTS = (() => {
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'numeric', year: 'numeric' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Europe/Kyiv' });
  } catch {
    // Engines whose tz database predates the 2022 rename only know the old spelling.
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Europe/Kiev' });
  }
})();

/** `12 бер 2026` in Europe/Kyiv, or `''` when the input is not a date. */
export function formatDate(iso: string | null | undefined): string {
  const date = new Date(iso ?? '');
  if (!iso || Number.isNaN(date.getTime())) return '';

  const parts = Object.fromEntries(KYIV_PARTS.formatToParts(date).map(p => [p.type, p.value]));
  return `${Number(parts['day'])} ${MONTHS_UK[Number(parts['month']) - 1]} ${parts['year']}`;
}

// ==================== PLURALS ====================

/**
 * Picks the Ukrainian plural form: `[1 сценарій, 2 сценарії, 5 сценаріїв]`. Returns the word only,
 * so the caller decides how the number is written. Fractions take the "few" (genitive singular) form.
 */
export function pluralUk(n: number, forms: readonly [one: string, few: string, many: string]): string {
  if (!Number.isInteger(n)) return forms[1];
  const abs = Math.abs(n);
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (last === 1 && lastTwo !== 11) return forms[0];
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return forms[1];
  return forms[2];
}
