// path: src/app/ui/format.spec.ts
//
// Covers test-plan scenario 118.
//
// Release 1, phase 2 - DW-2.5: byte sizes, Kyiv dates with our own month names, Ukrainian plurals.

import { formatBytes, formatDate, formatDateTime, pluralUk } from './format';

describe('formatBytes', () => {
  it('DW-2.5 formats 50537267 bytes as "48,2 МБ"', () => {
    expect(formatBytes(50537267)).toBe('48,2 МБ');
  });

  it('formats the unit boundaries', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(1023)).toBe('1023 Б');
    expect(formatBytes(1024)).toBe('1 КБ');
    expect(formatBytes(1048576)).toBe('1 МБ');
    expect(formatBytes(1073741824)).toBe('1 ГБ');
  });

  it('keeps one decimal with a comma and drops a whole ",0"', () => {
    expect(formatBytes(2150)).toBe('2,1 КБ');
    expect(formatBytes(412 * 1024)).toBe('412 КБ');
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 МБ');
    expect(formatBytes(1.5 * 1048576)).toBe('1,5 МБ');
  });

  it('promotes the unit when rounding reaches 1024', () => {
    expect(formatBytes(1048575)).toBe('1 МБ');
    expect(formatBytes(1048576 * 1024 - 1)).toBe('1 ГБ');
  });

  it('stays in gigabytes beyond 1024 ГБ instead of inventing a unit', () => {
    expect(formatBytes(2048 * 1073741824)).toBe('2048 ГБ');
  });

  it('DW-2.5 renders nothing for a missing or nonsensical size', () => {
    for (const value of [null, undefined, NaN, Infinity, -1]) expect(formatBytes(value as number | null | undefined)).toBe('');
  });
});

describe('formatDateTime', () => {
  it('writes the Kyiv wall clock after the date (winter UTC+2, summer UTC+3)', () => {
    expect(formatDateTime('2026-03-12T12:22:00Z')).toBe('12 бер 2026, 14:22');
    expect(formatDateTime('2026-07-01T09:05:00Z')).toBe('1 лип 2026, 12:05');
  });

  it('shows midnight as 00:xx, not 24:xx', () => {
    expect(formatDateTime('2026-03-12T22:07:00Z')).toBe('13 бер 2026, 00:07');
  });

  it('is empty for a missing or invalid date', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('nope')).toBe('');
  });
});

describe('formatDate', () => {
  it('DW-2.5 formats 2026-03-12T10:00:00Z as "12 бер 2026"', () => {
    expect(formatDate('2026-03-12T10:00:00Z')).toBe('12 бер 2026');
  });

  it('uses Kyiv calendar days: a late-evening UTC instant is already the next day in Kyiv', () => {
    expect(formatDate('2026-03-12T23:30:00Z')).toBe('13 бер 2026');
    expect(formatDate('2026-12-31T22:30:00Z')).toBe('1 січ 2027');
    expect(formatDate('2026-07-01T21:30:00Z')).toBe('2 лип 2026'); // summer time, UTC+3
  });

  it('writes the prototype month names, not Intl\'s "бер." / "р."', () => {
    const months = Array.from({ length: 12 }, (_, i) => formatDate(`2026-${String(i + 1).padStart(2, '0')}-15T12:00:00Z`));
    expect(months).toEqual([
      '15 січ 2026', '15 лют 2026', '15 бер 2026', '15 кві 2026', '15 тра 2026', '15 чер 2026',
      '15 лип 2026', '15 сер 2026', '15 вер 2026', '15 жов 2026', '15 лис 2026', '15 гру 2026',
    ]);
    expect(months.join(' ')).not.toContain('.');
  });

  it('DW-2.5 returns "" for anything that is not a date', () => {
    for (const value of ['', 'not a date', '2026-13-45', null, undefined]) {
      expect(formatDate(value as string | null | undefined), String(value)).toBe('');
    }
  });
});

describe('pluralUk', () => {
  const forms = ['сценарій', 'сценарії', 'сценаріїв'] as const;
  const word = (n: number) => pluralUk(n, forms);

  it('DW-2.5 picks the form for 1, 2, 5, 11 and 21', () => {
    expect(word(1)).toBe('сценарій');
    expect(word(2)).toBe('сценарії');
    expect(word(5)).toBe('сценаріїв');
    expect(word(11)).toBe('сценаріїв');
    expect(word(21)).toBe('сценарій');
  });

  it('handles zero, the teens and the hundreds', () => {
    expect(word(0)).toBe('сценаріїв');
    expect(word(4)).toBe('сценарії');
    expect(word(12)).toBe('сценаріїв');
    expect(word(14)).toBe('сценаріїв');
    expect(word(22)).toBe('сценарії');
    expect(word(25)).toBe('сценаріїв');
    expect(word(101)).toBe('сценарій');
    expect(word(111)).toBe('сценаріїв');
    expect(word(112)).toBe('сценаріїв');
  });

  it('treats negatives like positives and fractions as the "few" form', () => {
    expect(word(-1)).toBe('сценарій');
    expect(word(1.5)).toBe('сценарії');
  });
});
