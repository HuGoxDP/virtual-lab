// path: src/app/pages/viewer/viewer-format.spec.ts
//
// Covers test-plan scenario 138 (DW-4.1, DW-4.7).
//
// The byte line of the loading screen and the launch-flag parser the viewer relied on before the
// restyle (characterization of `readFlag`, which moved here unchanged).

import { byteLabel, readFlag } from './viewer-format';

const MB = 1024 * 1024;

describe('byteLabel', () => {
  it('DW-4.1 known total: "X з Y МБ" with comma decimals', () => {
    expect(byteLabel(3.2 * MB, 48.2 * MB)).toBe('Завантаження архіву — 3,2 з 48,2 МБ');
  });

  it('DW-4.1 unknown total (0): "X МБ" with no total', () => {
    expect(byteLabel(5 * MB, 0)).toBe('Завантаження архіву — 5,0 МБ');
    expect(byteLabel(5 * MB, null)).toBe('Завантаження архіву — 5,0 МБ');
    expect(byteLabel(5 * MB, Number.NaN)).toBe('Завантаження архіву — 5,0 МБ');
  });

  it('DW-4.1 loaded greater than total: the wrong total is dropped, never "5 з 3"', () => {
    expect(byteLabel(5 * MB, 3 * MB)).toBe('Завантаження архіву — 5,0 МБ');
  });

  it('loaded equal to total is a complete download', () => {
    expect(byteLabel(2 * MB, 2 * MB)).toBe('Завантаження архіву — 2,0 з 2,0 МБ');
  });

  it('nothing loaded yet reads 0,0 з Y', () => {
    expect(byteLabel(0, 10 * MB)).toBe('Завантаження архіву — 0,0 з 10,0 МБ');
  });

  it('is empty when there is no archive download (null / undefined / NaN loaded)', () => {
    expect(byteLabel(null, 10 * MB)).toBe('');
    expect(byteLabel(undefined, undefined)).toBe('');
    expect(byteLabel(Number.NaN, 10 * MB)).toBe('');
  });

  it('a negative loaded value is clamped to zero', () => {
    expect(byteLabel(-5, 0)).toBe('Завантаження архіву — 0,0 МБ');
  });
});

describe('readFlag', () => {
  it('accepts 1, true (any case) and a bare flag', () => {
    expect(readFlag('1')).toBe(true);
    expect(readFlag('true')).toBe(true);
    expect(readFlag('TRUE')).toBe(true);
    expect(readFlag('')).toBe(true);
  });

  it('everything else, and a missing parameter, is off', () => {
    expect(readFlag(null)).toBe(false);
    expect(readFlag('0')).toBe(false);
    expect(readFlag('false')).toBe(false);
    expect(readFlag('yes')).toBe(false);
  });
});
